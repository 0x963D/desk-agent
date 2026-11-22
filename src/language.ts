import type { Language } from "./shapes.ts";
import { normalize } from "./text.ts";

// Common words that belong to one language only, written without diacritics because customers
// often type Romanian without them. A word that both languages use, such as "a", "in", "am" or
// "are", is in neither list.
const WORDS: Record<Language, ReadonlySet<string>> = {
  ro: new Set(
    `si sa ca ce cu de din la pe nu da un una unei este sunt sunteti fost fi fie mai dar sau daca cand
    unde cum acum deja inca doar foarte pentru despre dupa fara pana catre iar deci asa acest aceasta
    acesta cel cea lui lor ei noi voi va vom veti ati aveti avem avea poate puteti pot vreau vrea
    trebuie vine ajunge mult putin multumesc multumim rog buna ziua salut seara comanda comenzii
    comenzi coletul colet livrare livrarea adresa adresei zile lucratoare nostru noastra
    dumneavoastra dvs mea meu tau voastra imi iti ii ne se il alta altceva nimic toate inapoi bani
    banii cerere cererea echipa coleg colegul colega`.split(/\s+/),
  ),
  en: new Set(
    `the and you your yours is was were be been to of for with it its it's this that these those
    have has had will would can could should please order orders we our us i i'm i've i'd i'll me
    my not on at from what when where which who how if or just so thanks thank hi hello there
    they them their here any all some about after before into than then also only but don't
    can't won't isn't doesn't didn't you're you'll we're we'll we've that's there's let get got
    want need know see sent send ship shipped shipping delivery delivered address request refund
    return staff approve team colleague days working`.split(/\s+/),
  ),
};

// Text that reads the same in either language: links, emails, order numbers and other numbers.
const NEUTRAL = /https?:\/\/\S+|\S+@\S+|\b[a-z]+\.example\S*|\bsc-?\d+\b|\d+([.,]\d+)*/g;

// A word is letters joined by hyphens or apostrophes, so "n-ar" and "don't" stay one word.
const WORD = /\p{L}+(?:['’-]\p{L}+)*/gu;

// A reading is confident only with this many words in the text and this many of them
// from one list.
const MIN_WORDS = 4;
const MIN_HITS = 3;
// Mixed text: the other list may hold at most one word for every this many of the winner's.
const DOMINANCE = 5;

export type Reading = Language | "unsure";

// The language of a message, from its words alone. Short text, text that is mostly a link or an
// order number, and mixed text read as "unsure".
export function languageOf(text: string): Reading {
  const words = normalize(text).replaceAll("’", "'").replace(NEUTRAL, " ").match(WORD) ?? [];
  if (words.length < MIN_WORDS) return "unsure";
  const hits = (language: Language) => words.filter((word) => WORDS[language].has(word)).length;
  const ro = hits("ro");
  const en = hits("en");
  const [winner, top, other] = ro > en ? (["ro", ro, en] as const) : (["en", en, ro] as const);
  return top >= MIN_HITS && other * DOMINANCE <= top ? winner : "unsure";
}
