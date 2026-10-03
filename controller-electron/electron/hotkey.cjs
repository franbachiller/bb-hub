function normalizeHotkey(value) {
  if (typeof value !== "string" || value.length > 80) throw new Error("Atajo inválido.");
  if (!value.trim()) return "";
  const parts = value.trim().split("+").map(x => x.trim());
  const key = parts.pop().toUpperCase();
  const aliases = { ctrl: "Control", control: "Control", alt: "Alt", shift: "Shift", super: "Super", win: "Super" };
  const modifiers = parts.map(x => aliases[x.toLowerCase()]);
  if (modifiers.some(x => !x) || new Set(modifiers).size !== modifiers.length ||
      !/^(F([1-9]|1[0-9]|2[0-4])|[A-Z0-9])$/.test(key) ||
      (!/^F\d+$/.test(key) && !modifiers.includes("Control") && !modifiers.includes("Alt") && !modifiers.includes("Super"))) {
    throw new Error("Usa F1–F24 o Ctrl/Alt/Win con una letra o un número.");
  }
  return [...["Control", "Alt", "Shift", "Super"].filter(x => modifiers.includes(x)), key].join("+");
}
module.exports = { normalizeHotkey };
