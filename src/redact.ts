// Masks the personal data a customer types or a function returns, so it never reaches a log or a
// terminal line outside the conversation. Order numbers, statuses, dates and prices stay, because
// support staff follow a log by them.

// No letter or digit may touch a match.
const START = String.raw`(?<![\p{L}\p{N}_])`;
const END = String.raw`(?![\p{L}\p{N}_])`;

const EMAIL = new RegExp(String.raw`${START}[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+`, "gu");

// A country code, two check digits, then groups of four letters or digits, spaced or not. A real
// account number holds at least ten digits, which keeps a phrase such as `ab12 this that` out.
const IBAN = new RegExp(String.raw`${START}[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?${END}`, "giu");
const maskIban = (match: string) => (match.replace(/\D/g, "").length >= 10 ? "[iban]" : match);

const HOUSE_NUMBER = String.raw`(?:nr\.?\s*)?\d+[a-z]?(?:\s*[-/]\s*\d+[a-z]?)?`;
const BLOCK_AND_FLAT = String.raw`(?:,?\s*(?:bl|sc|et|ap)\.?\s*[\p{L}\p{N}]+)*`;

// A street word, up to six words, then a house number: `Str. Pisicii Tărcate 7`.
const STREET_FIRST = new RegExp(
  String.raw`${START}(?:str(?:ada)?|bd|b-dul|bulevardul|calea|[șs]os(?:eaua)?|aleea|pia[țt]a|splaiul|intrarea)\.?\s+(?:[\p{L}'’.-]+\s+){1,6}${HOUSE_NUMBER}${BLOCK_AND_FLAT}${END}`,
  "giu",
);

// A house number, up to four words, then a street word: `7 Paper Heron Row`.
const NUMBER_FIRST = new RegExp(
  String.raw`${START}\d+[a-z]?,?\s+(?:[\p{L}'’-]+\s+){1,4}(?:street|st|road|rd|row|avenue|ave|lane|drive|way|close|court|place|square|crescent|terrace|boulevard|gardens|mews)\.?${END}`,
  "giu",
);

// A compound street name, then a house number: `Beispielweg 4`, `Papierenvlinderstraat 4`.
const COMPOUND = new RegExp(
  String.raw`${START}[\p{L}-]+(?:straat|strasse|straße|gasse|weg|laan|plein|gracht|kade|platz|allee)\s+${HOUSE_NUMBER}${END}`,
  "giu",
);

// An order number and an ISO date are matched first and kept whole, so no run of digits can take
// one in. Any other run is digits with at most two spaces, dots, hyphens or brackets between each,
// and an optional `+`. Only a digit ends a run, so a letter that touches a card number hides nothing.
const KEPT = String.raw`SC-\d{4}(?!\d)|\d{4}-\d{2}-\d{2}(?!\d)`;
const NUMBERS = new RegExp(String.raw`${KEPT}|\+?\(?(?<!\d)\d(?:[ .()-]{0,2}\d)*\)?(?!\d)`, "gu");
const WHOLLY_KEPT = new RegExp(String.raw`^(?:${KEPT})$`);

// A run of nine digits or more is masked: 13 to 19 as a card number, otherwise as a phone number.
// A shorter run stays, such as a price, a house number or a size.
function maskDigits(run: string): string {
  if (WHOLLY_KEPT.test(run)) return run;
  const digits = run.replace(/\D/g, "").length;
  if (digits < 9) return run;
  return digits >= 13 && digits <= 19 && !/^(?:\+|00)/.test(run) ? "[card]" : "[phone]";
}

export function redact(text: string): string {
  return text
    .replace(EMAIL, "[email]")
    .replace(IBAN, maskIban)
    .replace(STREET_FIRST, "[address]")
    .replace(NUMBER_FIRST, "[address]")
    .replace(COMPOUND, "[address]")
    .replace(NUMBERS, maskDigits);
}

// A copy of the value with every string in it passed through `redact`. The value is not changed.
export function redacted<T>(value: T): T {
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") return redact(node);
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === "object") {
      return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, walk(child)]));
    }
    return node;
  };
  return walk(value) as T;
}
