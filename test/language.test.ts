import { expect, test } from "vitest";
import { grade, passed, tookWrongAction } from "../src/grade.ts";
import { loadSplit } from "../src/files.ts";
import { languageOf } from "../src/language.ts";
import { runCase } from "../src/runner.ts";
import { caseExpecting, ROOT, scripted, testBackend } from "./helpers.ts";

test.each([
  ["Romanian without diacritics", "buna, vreau sa stiu cand ajunge comanda mea", "ro"],
  ["Romanian with diacritics", "Comanda a fost deja expediată, așa că un coleg va prelua solicitarea.", "ro"],
  ["Romanian slang", "adica cash cand vine coletul. sau mere doar cu cardu?", "ro"],
  ["English", "Hi, I'd like to return a print and get a refund.", "en"],
  ["English after an order number and a link", "SC-1309 has shipped. Track it here: https://curier.example/track/SC1309", "en"],
])("%s reads as its language", (_, text, language) => {
  expect(languageOf(text)).toBe(language);
});

test.each([
  ["a short reply", "Order SC-1334 is in production."],
  ["a reply that is mostly an order number and a link", "SC-1309: https://curier.example/track/SC1309"],
  ["an email and an order number", "Comanda SC-1330, tiberiu.manole@example.com"],
  ["mixed text", "Nu pot înregistra cererea: Production has started, so the order can no longer be cancelled."],
  ["no words", "?? :)"],
])("%s is unsure", (_, text) => {
  expect(languageOf(text)).toBe("unsure");
});

// The case's language field names the first customer turn. These turns switch, read by hand.
const SWITCHED: Record<string, Record<number, "ro" | "en">> = {
  "en-new-address-after-shipping": { 1: "ro", 2: "ro" },
  "ro-programare-tatuaj-pentru-prieten": { 1: "en", 2: "en" },
};

test("every tuning customer turn reads as its language or as unsure, never as the other one", async () => {
  const { cases } = await loadSplit(ROOT, "tuning");
  const turns = cases.flatMap((c) =>
    c.turns.map((text, at) => ({ turn: `${c.id}#${at + 1}`, truth: SWITCHED[c.id]?.[at] ?? c.language, read: languageOf(text) })),
  );

  expect(turns.filter(({ read, truth }) => read !== "unsure" && read !== truth)).toEqual([]);
  expect(turns.filter(({ read }) => read !== "unsure").length).toBeGreaterThanOrEqual(0.9 * turns.length);
});

const replies = (...texts: string[]) => scripted(...texts.map((text) => () => ({ text, status: "resolved" as const })));

async function gradeReplies(turns: string[], texts: string[]) {
  const testCase = caseExpecting({ outcome: "resolved" }, { turns });
  return grade(testCase, await runCase(replies(...texts), testCase, await testBackend()));
}

test("a reply in another language than the message it answers fails, without being a wrong action", async () => {
  const result = await gradeReplies(
    ["Hello, how long does delivery take to Utrecht?"],
    ["Livrarea în alte țări din UE durează între 5 și 8 zile lucrătoare."],
  );

  expect(result.failures).toEqual([{ kind: "wrong_language", detail: "reply 1 is ro, the customer wrote en" }]);
  expect(passed(result)).toBe(false);
  expect(tookWrongAction(result)).toBe(false);
});

test("a reply follows the customer when they switch language", async () => {
  const turns = ["Hello, I need to change the delivery address on my order.", "Aș vrea să vină coletul la birou, nu acasă, dacă se poate."];
  const followed = await gradeReplies(turns, [
    "Of course. What is your order number and the email on the order?",
    "Sigur, vă ajut cu schimbarea adresei de livrare a comenzii.",
  ]);
  const stayed = await gradeReplies(turns, [
    "Of course. What is your order number and the email on the order?",
    "Of course, I can help you change the delivery address on the order.",
  ]);

  expect(followed.failures).toEqual([]);
  expect(stayed.failures).toEqual([{ kind: "wrong_language", detail: "reply 2 is en, the customer wrote ro" }]);
});

test("a reply or a message that reads as unsure never fails", async () => {
  const shortReply = await gradeReplies(["Hello, where is my order? I have been waiting all week."], ["SC-1309: https://curier.example/track/SC1309"]);
  const shortMessage = await gradeReplies(["SC-1309"], ["Vă rog să îmi spuneți și adresa de email de pe comandă."]);

  expect(shortReply.failures).toEqual([]);
  expect(shortMessage.failures).toEqual([]);
});
