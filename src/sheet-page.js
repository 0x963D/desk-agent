// The label sheet's script. `sheet` turns the reader's answers into verdict lines and holds no
// reference to the page, so test/sheet.test.ts runs it in Node. The block after it wires the page.
const sheet = (() => {
  const NAMES_A_TURN = /\bturn \d+\b/i;

  // What still keeps an answer from being a verdict, or undefined when it is one.
  function problem(answer) {
    if (!answer || answer.acceptable === null) return "Mark it acceptable or not acceptable.";
    if (answer.acceptable) return undefined;
    if (answer.failing.length === 0) return "Tick each criterion it fails.";
    if (!NAMES_A_TURN.test(answer.note)) return "Name the turn in the note, such as “Turn 4 promises a refund.”";
    return undefined;
  }

  function verdict(id, answer, criteria) {
    const line = { id, acceptable: answer.acceptable };
    for (const name of criteria) line[name] = answer.acceptable || !answer.failing.includes(name);
    line.note = answer.note.trim() || "No criterion fails.";
    return line;
  }

  // The verdict file: one line per finished conversation, in the sheet's order.
  function verdictFile(ids, answers, criteria) {
    return ids
      .filter((id) => problem(answers[id]) === undefined)
      .map((id) => `${JSON.stringify(verdict(id, answers[id], criteria))}\n`)
      .join("");
  }

  // An answer as the page keeps it. Anything else read back from storage starts blank.
  function answerFrom(value, criteria) {
    const blank = { acceptable: null, failing: [], note: "" };
    if (!value || typeof value !== "object") return blank;
    const acceptable = value.acceptable === true || value.acceptable === false ? value.acceptable : null;
    const failing = Array.isArray(value.failing) ? criteria.filter((name) => value.failing.includes(name)) : [];
    const note = typeof value.note === "string" ? value.note : "";
    return { acceptable, failing: acceptable === true ? [] : failing, note };
  }

  return { problem, verdict, verdictFile, answerFrom };
})();

if (typeof document !== "undefined") {
  const data = JSON.parse(document.getElementById("sheet-data").textContent);
  const sections = [...document.querySelectorAll("section.conversation")];
  const answers = {};
  let kept = true;
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(data.storageKey) ?? "{}") ?? {};
  } catch {
    kept = false;
  }
  for (const id of data.ids) answers[id] = sheet.answerFrom(stored[id], data.criteria);

  const warnNotKept = () => {
    kept = false;
    document.getElementById("storage-warning").hidden = false;
  };
  if (!kept) warnNotKept();

  const save = () => {
    try {
      localStorage.setItem(data.storageKey, JSON.stringify(answers));
    } catch {
      warnNotKept();
    }
  };

  const doneCount = () => data.ids.filter((id) => sheet.problem(answers[id]) === undefined).length;

  function show(section) {
    const answer = answers[section.dataset.id];
    for (const radio of section.querySelectorAll("input[type=radio]")) {
      radio.checked = answer.acceptable !== null && radio.value === (answer.acceptable ? "yes" : "no");
    }
    for (const box of section.querySelectorAll("input[type=checkbox]")) box.checked = answer.failing.includes(box.value);
    const note = section.querySelector("textarea");
    if (note.value !== answer.note) note.value = answer.note;
    const problem = sheet.problem(answer);
    section.dataset.done = String(problem === undefined);
    section.querySelector(".state").textContent = problem === undefined ? "Done" : "To do";
    section.querySelector(".hint").textContent = answer.acceptable === false ? (problem ?? "") : "";
  }

  function showProgress() {
    document.getElementById("done-count").textContent = String(doneCount());
  }

  for (const section of sections) {
    const answer = answers[section.dataset.id];
    section.addEventListener("change", (event) => {
      const input = event.target;
      if (input.type === "radio") {
        answer.acceptable = input.value === "yes";
        if (answer.acceptable) answer.failing = [];
      } else if (input.type === "checkbox") {
        answer.failing = data.criteria.filter((name) =>
          name === input.value ? input.checked : answer.failing.includes(name),
        );
        if (input.checked) answer.acceptable = false;
      } else {
        return;
      }
      save();
      show(section);
      showProgress();
    });
    section.querySelector("textarea").addEventListener("input", (event) => {
      answer.note = event.target.value;
      save();
      show(section);
      showProgress();
    });
    show(section);
  }
  showProgress();

  document.getElementById("next").addEventListener("click", () => {
    const next = sections.find((section) => section.dataset.done !== "true");
    const saved = document.getElementById("saved");
    if (!next) {
      saved.textContent = `All ${sections.length} are done. Press Download verdicts.`;
      document.getElementById("download").focus();
      return;
    }
    next.scrollIntoView({ block: "start" });
    next.querySelector("h2").focus({ preventScroll: true });
  });

  const rules = document.getElementById("rules");
  document.getElementById("rules-open").addEventListener("click", () => rules.showModal());
  document.getElementById("rules-close").addEventListener("click", () => rules.close());

  document.getElementById("download").addEventListener("click", () => {
    const saved = document.getElementById("saved");
    const done = doneCount();
    if (done === 0) {
      saved.textContent = "Nothing to download yet. No conversation is done.";
      return;
    }
    const url = URL.createObjectURL(new Blob([sheet.verdictFile(data.ids, answers, data.criteria)], { type: "application/x-ndjson" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = data.fileName;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    saved.textContent =
      done === data.ids.length
        ? `Downloaded ${data.fileName} with all ${done} conversations.`
        : `Downloaded ${data.fileName} with the ${done} of ${data.ids.length} conversations that are done. This browser keeps the rest.`;
  });
}
