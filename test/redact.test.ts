import { expect, test } from "vitest";
import { loadOrders, loadShop } from "../src/files.ts";
import { redact, redacted } from "../src/redact.ts";
import { ROOT } from "./helpers.ts";

test.each([
  ["an email", "scrieti-mi la sorin_d_1990@example.com va rog", "scrieti-mi la [email] va rog"],
  ["an email in capitals", "My email is Jonas.Weber@Example.COM.", "My email is [email]."],
  ["a Romanian mobile number", "sunati-ma la 0722 123 456", "sunati-ma la [phone]"],
  ["a number with the country code", "call me on +40 722 123 456 tomorrow", "call me on [phone] tomorrow"],
  ["a number with dots", "tel 0722.123.456", "tel [phone]"],
  ["a landline in brackets", "(021) 312 45 67 la birou", "[phone] la birou"],
  ["an Irish number", "+353 1 234 5678", "[phone]"],
  ["a number dialled with 00", "0040 722 123 456", "[phone]"],
  ["a card number in groups", "cardul 4111 1111 1111 1111 a fost taxat", "cardul [card] a fost taxat"],
  ["a card number with hyphens", "card 5500-0000-0000-0004", "card [card]"],
  ["a card number in one block", "4111111111111111", "[card]"],
  ["an IBAN in groups", "IBAN: RO49 AAAA 1B31 0075 9384 0000", "IBAN: [iban]"],
  ["an IBAN in one block, lower case", "contul ro49aaaa1b31007593840000", "contul [iban]"],
  ["a card number glued to a word", "card4111111111111111 x", "card[card] x"],
  ["a card number after a date and a comma", "2026-11-02, 4111 1111 1111 1111", "2026-11-02, [card]"],
  ["a phone number after an order number and a comma", "SC-1003, 0722 123 456", "SC-1003, [phone]"],
  ["a card number typed in the shape of a date", "4111-11-11 1111 1111", "[card]"],
  ["a date that touches a card number by a space", "2026-11-02 4111 1111 1111 1111", "[number]"],
  ["a card number and a phone number typed together", "4111 1111 1111 1111 0722 123 456", "[number]"],
  ["a Romanian street","Adresa noua e Str. Vulpii Argintii 12, Oradea.", "Adresa noua e [address], Oradea."],
  ["a street typed without capitals or dots", "pe str vulpii argintii 12 va rog", "pe [address] va rog"],
  ["a boulevard with block and flat", "Bd. Unirii nr. 5, bl. A2, ap. 14, București", "[address], București"],
  ["an English street", "send it to 7 Paper Heron Row, Dublin", "send it to [address], Dublin"],
  ["a German street", "Beispielweg 4, Leipzig", "[address], Leipzig"],
  ["a Dutch street", "Papierenvlinderstraat 4, Utrecht", "[address], Utrecht"],
])("%s is masked", (_, text, masked) => {
  expect(redact(text)).toBe(masked);
});

test.each([
  ["an order number", "Comanda SC-1318 e in productie."],
  ["two order numbers", "SC-1311 si SC-1302"],
  ["a tracking link", "https://curier.example/track/SC1206 and more words after it"],
  ["an ISO date", "placed on 2026-11-02, delivered 2026-11-10"],
  ["a timestamp", "2026-11-22T12:33:06.460Z"],
  ["a Romanian date", "livrat pe 22.11.2026"],
  ["prices", "Open prints cost 150 to 450 lei, limited drops 1,500 lei or 1.500,00 lei."],
  ["a model cost", "$0.0002 for 2,341 ms"],
  ["a status", "status in_production, refund above 1000 lei goes to a person"],
  ["a size", "30x40 cm"],
  ["a request and a handover id", "request R-1 is pending_approval, handover H-1"],
  ["a delivery time", "3 to 5 working days, then 1 to 2 days"],
  ["words that start like an IBAN", "ab12 this that and the other"],
])("%s stays", (_, text) => {
  expect(redact(text)).toBe(text);
});

test("every delivery address in the tuning orders is masked", async () => {
  const orders = await loadOrders(ROOT, "tuning", await loadShop(ROOT));
  expect(orders.length).toBeGreaterThan(10);
  for (const { delivery } of orders) {
    const street = delivery.address.split(",")[0]!;
    expect(redact(delivery.address)).not.toContain(street);
    expect(redact(delivery.address)).toContain("[address]");
  }
});

test("redacted masks every string in a value and leaves the value itself alone", () => {
  const value = {
    order_id: "SC-1003",
    total_ron: 150,
    delivery: { address: "Beispielweg 4, Leipzig" },
    emails: ["jonas.weber@example.com"],
  };
  const before = structuredClone(value);

  expect(redacted(value)).toEqual({
    order_id: "SC-1003",
    total_ron: 150,
    delivery: { address: "[address], Leipzig" },
    emails: ["[email]"],
  });
  expect(value).toEqual(before);
});
