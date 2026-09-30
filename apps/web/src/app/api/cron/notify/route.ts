/**
 * /api/cron/notify — scheduled worker that pushes a notification to the recipient of a
 * tip (#297). Runs on Vercel cron (see apps/web/vercel.json) once a minute.
 *
 * Auth: `Authorization: Bearer <CRON_SECRET>`. Vercel sends that header automatically.
 * Requests without the secret are 401; a deployment without the secret is 503 (the
 * endpoint is disabled rather than open).
 *
 * Flow:
 *   1. read the cursor from the store (getCursor)
 *   2. fetch `tipped` events since that cursor (fetchTipEventsSince)
 *   3. for each event whose recipient has subscriptions, and which the seen-set has
 *      not already recorded, send one push with a `url` field for sw.js to open
 *   4. mark the event seen (markEventSeen), send the push
 *   5. advance the cursor (setCursor) to the last good cursor returned by the fetch
 *
 * A mid-batch failure stops before advancing the cursor, so the next cron run retries
 * the same window; the seen-set prevents double sends for events already pushed.
 */
import { NextRequest, NextResponse } from 'next/server';
import { withRoute } from '@/lib/api-route';
import { fetchTipEventsSince } from '@/lib/events';
import { getSubscriptionsForWallet, removeSubscription } from '@/lib/push-store';
import { getCursor, setCursor, isEventSeen, markEventSeen } from '@/lib/push-store';
import { reverseHandles } from '@/lib/registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** USDC has 7 decimals on Stellar. */
const USDC_DECIMALS = 7;
const USDC_ONE = 10 ** USDC_DECIMALS;

/**
 * Format an i128 amount (as it appears after scValToNative: a bigint) as a short
 * USDC string. Trims trailing zeros, keeps up to 2 decimals.
 */
function formatUsdc(amount: bigint): string {
  if (amount <= 0n) return '0';
  // Integer part
  const whole = amount / BigInt(USDC_ONE);
  const frac = amount % BigInt(USDC_ONE);
  if (frac === 0n) return whole.toString();
  // Up to 2 decimals: 0.xx
  const hundredths = frac / BigInt(USDC_ONE / 100);
  if (hundredths === 0n) return whole.toString();
  const fracStr = hundredths.toString().padStart(2, '0').replace(/0+$/, '');
  return `${whole}.${fracStr}`;
}

/** Shorten an address for display when a handle is not available. */
function shortAddr(addr: string): string {
  return addr.length > 10 ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : addr;
}

export const GET = withRoute('GET /api/cron/notify', async (req: NextRequest) => {
  // 1. Auth
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 });
  }
  const auth = req.headers.get('authorization');
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // 2. VAPID check — graceful degrade if push is not configured, same shape as notify.
  const vapidSubject = process.env.VAPID_SUBJECT;
  const vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;
  if (!vapidSubject || !vapidPublicKey || !vapidPrivateKey) {
    return NextResponse.json({ ok: true, sent: 0, skipped: true });
  }

  let webpush: typeof import('web-push');
  try {
    webpush = await import('web-push');
  } catch {
    return NextResponse.json({ ok: false, error: 'web-push not installed' }, { status: 500 });
  }
  webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);

  // 3. Read cursor
  const previousCursor = await getCursor();

  // 4. Fetch events
  const { events, cursor: nextCursor } = await fetchTipEventsSince(previousCursor);

  if (events.length === 0) {
    if (nextCursor && nextCursor !== previousCursor) await setCursor(nextCursor);
    return NextResponse.json({ ok: true, processed: 0, sent: 0 });
  }

  // 5. Collect distinct recipient addresses so the handle lookup is one batched call.
  const recipients = new Set<string>();
  for (const ev of events) {
    const to = ev.topics[2];
    if (typeof to === 'string') recipients.add(to);
  }
  let handles: Record<string, string | null> = {};
  try {
    handles = await reverseHandles([...recipients]);
  } catch {
    // Non-fatal — notifications just show the short address instead of the handle.
  }

  // 6. Process
  let sent = 0;
  let processed = 0;
  for (const ev of events) {
    const from = ev.topics[1];
    const to = ev.topics[2];
    const amount = ev.data;

    if (typeof from !== 'string' || typeof to !== 'string' || typeof amount !== 'bigint') {
      // Malformed event — skip but count it as processed so the cursor can move on.
      processed++;
      continue;
    }

    // The RPC sometimes omits the id — those cannot be deduplicated, so skip them.
    const eventId = ev.id;
    if (!eventId) {
      processed++;
      continue;
    }

    if (await isEventSeen(eventId)) {
      processed++;
      continue;
    }

    const subs = await getSubscriptionsForWallet(to);
    if (subs.length > 0) {
      const senderLabel = handles[from] ? `@${handles[from]}` : shortAddr(from);
      const payload = JSON.stringify({
        title: '💸 You received a tip',
        body: `${senderLabel} tipped you ${formatUsdc(amount)} USDC`,
        url: '/app',
      });

      const results = await Promise.all(
        subs.map(async (stored) => {
          try {
            await webpush.sendNotification(
              stored.subscription as Parameters<typeof webpush.sendNotification>[0],
              payload,
            );
            return 'ok' as const;
          } catch (err: unknown) {
            const status = (err as { statusCode?: number })?.statusCode;
            if (status === 410 || status === 404) {
              await removeSubscription(stored.endpoint).catch(() => {});
              return 'gone' as const;
            }
            return 'failed' as const;
          }
        }),
      );
      if (results.includes('ok')) sent++;
      if (results.includes('failed')) {
        // Hard failure on this event — stop. Do not advance the cursor; the seen-set
        // will prevent re-sending events that already pushed on the next run.
        return NextResponse.json({ ok: false, processed, sent, error: 'send failed' });
      }
    }

    await markEventSeen(eventId);
    processed++;
  }

  // 7. Advance cursor to the last RPC cursor returned by the scan.
  // Never store an event id here — the cursor argument to getEvents expects the
  // opaque string from the previous response, not an event identifier.
  if (nextCursor && nextCursor !== previousCursor) await setCursor(nextCursor);

  return NextResponse.json({ ok: true, processed, sent });
});
