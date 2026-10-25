import { q } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { body, handle, json, str } from "@/lib/http";
import { currentEvent } from "@/lib/status";
import { createAlert } from "@/lib/alerts";
import { LEVEL_ORDER, HAZARD_LABEL, type Level } from "@/lib/risk";
import { ZONE_BY_ID, type Hazard } from "@/lib/geo";
import { LANGS, checkinText } from "@/lib/i18n";

export const POST = handle(async (req: Request) => {
  const s = await requireAdmin();
  const b = await body(req);
  const ev = await currentEvent();
  const zoneId = str(b.zoneId, 40) || null;
  if (zoneId && !ZONE_BY_ID[zoneId]) return json({ error: "Unknown area." }, 400);

  if (b.type === "checkin") {
    // Ask everyone in the area to check in, in their own language.
    for (const l of LANGS) {
      const params: unknown[] = [ev.id, `StormShield: ${checkinText(l.code)}`, l.code];
      let where = `u.role = 'user' AND u.language = $3`;
      if (zoneId) {
        params.push(zoneId);
        where += ` AND (u.home_zone = $4 OR u.work_zone = $4)`;
      }
      await q(
        `INSERT INTO messages (event_id, user_id, to_name, to_phone, channel, body)
         SELECT $1, u.id, u.first_name || ' ' || u.surname, u.phone, c.ch, $2 FROM users u CROSS JOIN (VALUES ('push'),('sms')) c(ch) WHERE ${where}`,
        params,
      );
    }
    return json({ ok: true });
  }

  const level = str(b.level, 10) as Level;
  const hazard = str(b.hazard, 20) as Hazard;
  if (!LEVEL_ORDER.includes(level)) return json({ error: "Choose a level." }, 400);
  if (!(hazard in HAZARD_LABEL)) return json({ error: "Choose a hazard." }, 400);
  const custom = str(b.message, 320) || null;
  await createAlert(q, { eventId: ev.id, zoneId, level, hazard, kind: "broadcast", custom, createdBy: s.uid });
  return json({ ok: true });
});
