import { test } from "node:test";
import assert from "node:assert/strict";
import { redFlag, extractJson, mentionsMedication, partialReply } from "../lib/chat.ts";

test("red flags fire on genuine emergencies", () => {
  const emergencies = [
    "crushing chest pain and I can't breathe",
    "chest tightness with sweating for 20 minutes",
    "his face is drooping and he has slurred speech",
    "cut my hand and the bleeding won't stop",
    "she is unresponsive after a seizure",
    "I want to kill myself",
    "coughing up blood since morning",
    "worst headache of my life, came on suddenly",
    "my throat is closing, severe allergic reaction",
  ];
  for (const t of emergencies) assert.ok(redFlag(t), `should flag: ${t}`);
});

test("red flags stay quiet on ordinary symptoms", () => {
  const ordinary = [
    "I have a dull headache and feel tired",
    "mild chest congestion from a cold",
    "my gums bleed a little when I brush",
    "knee pain after playing football",
    "itchy rash on my arm for a week",
    "breathless when I climb four flights of stairs",
  ];
  for (const t of ordinary) assert.equal(redFlag(t), null, `should not flag: ${t}`);
});

test("extractJson survives fences and model preamble", () => {
  const raw =
    'Sure! Here is the JSON:\n```json\n{"reply":"Noted.","assessment":"Usually looked at for X.",' +
    '"urgency":"soon","nextSteps":["Book the appointment.","Write down when it started."],' +
    '"doctorIds":[3],"testCodes":["CBC","LFT"],"outOfScope":false,"needClarify":false}\n```\nHope that helps.';
  assert.deepEqual(extractJson(raw), {
    reply: "Noted.",
    assessment: "Usually looked at for X.",
    urgency: "soon",
    nextSteps: ["Book the appointment.", "Write down when it started."],
    question: null,
    doctorIds: [3],
    testCodes: ["CBC", "LFT"],
    outOfScope: false,
    offTopic: false,
  });
});

test("extractJson rejects junk and coerces bad id lists", () => {
  assert.equal(extractJson("I cannot help with that."), null);
  assert.equal(extractJson('{"reply": ""}'), null);
  assert.equal(extractJson("{broken"), null);
  assert.deepEqual(
    extractJson('{"reply":"ok","doctorIds":"3","testCodes":["cbc", 7, "", " mri-br "],"urgency":"panic"}'),
    {
      reply: "ok",
      assessment: "",
      urgency: "routine",
      nextSteps: [],
      question: null,
      doctorIds: [],
      testCodes: ["CBC", "MRI-BR"],
      outOfScope: false,
      offTopic: false,
    },
  );
});

test("medication advice voids the whole answer, wherever it hides", () => {
  const withDrug = (field, value) =>
    extractJson(JSON.stringify({ reply: "ok", assessment: "", nextSteps: [], [field]: value }));

  assert.equal(withDrug("reply", "Take paracetamol 500mg twice daily."), null);
  assert.equal(withDrug("assessment", "Often managed with ibuprofen."), null);
  assert.equal(
    extractJson('{"reply":"ok","nextSteps":["Book the appointment.","Take two tablets tonight."]}'),
    null,
  );
  // Talking *about* medication without advising it must still get through.
  assert.ok(extractJson('{"reply":"Bring a list of your medications to the appointment."}'));
  assert.ok(extractJson('{"reply":"I cannot tell you what to take. The doctor decides that."}'));
});

test("mentionsMedication catches doses and drug names, not ordinary words", () => {
  for (const t of ["paracetamol", "500 mg", "ibuprofen twice a day", "use the inhaler", "take two tablets"])
    assert.ok(mentionsMedication(t), `should catch: ${t}`);
  for (const t of ["your medical history", "bring your prescriptions", "the pain started on Tuesday"])
    assert.equal(mentionsMedication(t), false, `should allow: ${t}`);
});

test("partialReply reads the reply out of JSON that is still being written", () => {
  // The exact prefixes a stream produces, one growing chunk at a time.
  assert.equal(partialReply('{"'), "");
  assert.equal(partialReply('{"reply'), "");
  assert.equal(partialReply('{"reply":"'), "");
  assert.equal(partialReply('{"reply":"You sho'), "You sho");
  assert.equal(partialReply('{"reply":"Done.","urgency":"soon"}'), "Done.");

  // Escapes: a quote inside the string must not look like the end of it, and a
  // backslash arriving as the last byte of a chunk must wait for its partner.
  assert.equal(partialReply('{"reply":"the \\"worst\\" pain'), 'the "worst" pain');
  assert.equal(partialReply('{"reply":"line one\\nline two"}'), "line one\nline two");
  assert.equal(partialReply('{"reply":"trailing\\'), "trailing");

  // A different field opening first must not be mistaken for the reply.
  assert.equal(partialReply('{"urgency":"soon","reply":"Hello'), "Hello");
});

test("a question suppresses any answer offered alongside it", () => {
  const asked = extractJson(
    JSON.stringify({
      reply: "I need one more detail.",
      assessment: "Often looked at for something.",
      nextSteps: ["Book an appointment."],
      question: { text: "How long?", options: ["Days", "Weeks"] },
      doctorIds: [3],
      testCodes: ["CBC"],
    }),
  );
  // Recommending and asking in the same breath is contradictory; the question wins.
  assert.deepEqual(asked.question, { text: "How long?", options: ["Days", "Weeks"] });
  assert.deepEqual([asked.assessment, asked.nextSteps, asked.doctorIds, asked.testCodes], ["", [], [], []]);

  // A question with fewer than two usable options is prose, not a widget.
  const thin = (options) =>
    extractJson(JSON.stringify({ reply: "ok", question: { text: "How long?", options } }));
  assert.equal(thin(["Days"]).question, null);
  assert.equal(thin([]).question, null);
  assert.equal(thin(["Days", 7, ""]).question, null);
  assert.equal(extractJson('{"reply":"ok","question":{"options":["a","b"]}}').question, null);
});