export const allowedMentions = { parse: [] };
export const message = (content, extra = {}) => ({
  type: 4,
  data: {
    content: String(content).slice(0, 1900),
    flags: 64,
    allowed_mentions: allowedMentions,
    ...extra,
  },
});
export const deferred = () => ({ type: 5, data: { flags: 64 } });
export function embed(title, description = "", fields = []) {
  const t = String(title).slice(0, 256),
    d = String(description).slice(0, 4000);
  let remaining = 5800 - t.length - d.length;
  const safe = [];
  for (const f of fields.slice(0, 25)) {
    if (remaining < 4) break;
    const name = String(f.name || "Answer").slice(
      0,
      Math.min(256, remaining - 1),
    );
    remaining -= name.length;
    const value = String(f.value || "—").slice(0, Math.min(1024, remaining));
    remaining -= value.length;
    safe.push({ name, value, ...(f.inline ? { inline: true } : {}) });
  }
  return {
    title: t,
    description: d || undefined,
    color: 0x00b7ff,
    fields: safe,
  };
}
export const button = (label, custom_id, style = 2) => ({
  type: 2,
  label: label.slice(0, 80),
  style,
  custom_id,
});
export const link = (label, url) => ({ type: 2, style: 5, label, url });
export const row = (...components) => ({ type: 1, components });
export const select = (custom_id, options, placeholder = "Choose a view") =>
  row({ type: 3, custom_id, placeholder, options: options.slice(0, 25) });
export function modal(custom_id, title, fields) {
  return {
    type: 9,
    data: {
      custom_id,
      title: title.slice(0, 45),
      components: fields.slice(0, 5).map((f) =>
        row({
          type: 4,
          custom_id: f.id,
          label: f.label.slice(0, 45),
          style: f.long ? 2 : 1,
          required: f.required !== false,
          max_length: f.max || 4000,
          ...(f.value ? { value: f.value } : {}),
        }),
      ),
    },
  };
}
