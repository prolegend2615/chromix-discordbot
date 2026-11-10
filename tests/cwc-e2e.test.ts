import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";

import { handleCwcCommand, parseCwcPrefixInvocation, type CwcCommandReply } from "../src/commands/cwc.js";
import {
  MAX_CWC_FEEDBACK_TURNS,
  applyCwcResponse,
  createCwcLoopState,
  shouldEnableCwc,
} from "../src/services/cwc-loop.js";
import {
  clearSlot,
  deleteUserWorkspaces,
  ensureUserSlots,
  formatCwcOperationResults,
  listSlotFiles,
  setActiveSlot,
  workspaceHasFiles,
  writeSlotFile,
} from "../src/services/cwc.js";
import { setVip } from "../src/services/settings.js";

function fakeContext(userId: string, guildId = "e2e-guild") {
  const replies: CwcCommandReply[] = [];
  return {
    replies,
    context: {
      userId,
      guildId,
      ephemeral: false,
      reply: async (payload: CwcCommandReply) => {
        replies.push(payload);
        return {};
      },
    },
  };
}

async function prepareUser(userId: string) {
  await setVip(userId, true);
  await ensureUserSlots(userId);
  await setActiveSlot(userId, 1);
  await clearSlot(userId, 1);
  await clearSlot(userId, 2);
  await clearSlot(userId, 3);
}

async function cleanupUser(userId: string) {
  await deleteUserWorkspaces(userId);
  await setVip(userId, false);
}

test("routes c.cwc prefix invocations like the Discord message handler", () => {
  assert.equal(parseCwcPrefixInvocation("hello"), null);
  assert.equal(parseCwcPrefixInvocation("c.cwcx"), null);

  const bare = parseCwcPrefixInvocation("c.cwc");
  assert.equal(bare?.subcommand, "list");
  assert.equal(bare?.slot, undefined);
  assert.equal(bare?.name, undefined);

  const files = parseCwcPrefixInvocation("c.cwc files 2");
  assert.equal(files?.subcommand, "files");
  assert.equal(files?.slot, 2);

  const renamed = parseCwcPrefixInvocation("C.CWC rename 3 My Bot Project");
  assert.equal(renamed?.subcommand, "rename");
  assert.equal(renamed?.slot, 3);
  assert.equal(renamed?.name, "My Bot Project");

  assert.equal(parseCwcPrefixInvocation("c.cwc switch abc")?.slot, undefined);
});

test("rejects non-VIP users before touching workspace state", async () => {
  const userId = `e2e-cwc-nonvip-${Date.now()}`;
  await setVip(userId, false);
  const { context, replies } = fakeContext(userId);

  await assert.rejects(() => handleCwcCommand(context, "list"), /VIP feature/);
  assert.equal(replies.length, 0);
  assert.equal(workspaceHasFiles(userId), false);

  await cleanupUser(userId);
});

test("executes the c.cwc management surface with mention-safe replies", async () => {
  const userId = `e2e-cwc-manage-${Date.now()}`;
  await prepareUser(userId);
  await writeSlotFile(userId, "main.py", "print('hi')\n");

  const renamed = fakeContext(userId);
  await handleCwcCommand(renamed.context, "rename", { slot: 1, name: "@everyone <@123>" });
  assert.match(String(renamed.replies[0]?.content), /Renamed slot 1/);
  assert.deepEqual(renamed.replies[0]?.allowedMentions, { parse: [], repliedUser: false });

  const listed = fakeContext(userId);
  await handleCwcCommand(listed.context, "list");
  const description = listed.replies[0]?.embeds?.[0]?.toJSON().description ?? "";
  assert.match(description, /@everyone/);
  assert.match(description, /1\/10 files/);
  assert.deepEqual(listed.replies[0]?.allowedMentions?.parse, []);

  const files = fakeContext(userId);
  await handleCwcCommand(files.context, "files", { slot: 1 });
  assert.match(String(files.replies[0]?.content), /`main\.py`/);
  assert.match(String(files.replies[0]?.content), /2 lines/);

  const switched = fakeContext(userId);
  await handleCwcCommand(switched.context, "switch", { slot: 2 });
  assert.match(String(switched.replies[0]?.content), /Switched to slot 2/);

  const cleared = fakeContext(userId);
  await handleCwcCommand(cleared.context, "clear", { slot: 2 });
  assert.match(String(cleared.replies[0]?.content), /Cleared 0 files from slot 2/);

  await assert.rejects(() => handleCwcCommand(fakeContext(userId).context, "unknown"), /Usage:/);
  await assert.rejects(() => handleCwcCommand(fakeContext(userId).context, "switch"), /Usage:/);

  await cleanupUser(userId);
});

test("downloads the active slot as a real zip attachment", async () => {
  const userId = `e2e-cwc-zip-${Date.now()}`;
  await prepareUser(userId);
  await writeSlotFile(userId, "src/app.py", "print(1)\n");

  const { context, replies } = fakeContext(userId);
  await handleCwcCommand(context, "download", { slot: 1 });

  const attachment = replies[0]?.files?.[0];
  assert.ok(attachment);
  assert.equal(attachment.name, "chromix-cwc-slot-1.zip");
  assert.ok(Buffer.isBuffer(attachment.attachment));

  const zip = await JSZip.loadAsync(attachment.attachment);
  const entry = zip.file("src/app.py");
  assert.ok(entry);
  assert.equal(await entry.async("string"), "print(1)\n");
  assert.match(String(replies[0]?.content), /1 file\b/);

  await cleanupUser(userId);
});

test("runs the CWC multi-turn write/read loop against the real workspace", async () => {
  const userId = `e2e-cwc-loop-${Date.now()}`;
  await prepareUser(userId);

  assert.equal(await shouldEnableCwc(userId, true, "please explain this code"), true);
  assert.equal(await shouldEnableCwc(userId, true, "hello there"), false);
  assert.equal(await shouldEnableCwc(userId, false, "create main.py"), false);
  assert.equal(await shouldEnableCwc(userId, true, "hello there", true), false);

  const state = await createCwcLoopState(userId);
  assert.match(String(state.workspaceSummary), /status="empty"/);

  const writeResponse = [
    "Sure, here it is.",
    "<<<CHROMIX_ACTION_START:WRITE_FILE>>>",
    "[PATH: hello.py]",
    "[CONTENT]",
    "print('hi')",
    "<<<CHROMIX_ACTION_END>>>",
  ].join("\n");

  const writeOutcome = await applyCwcResponse(userId, writeResponse, state);
  assert.deepEqual(writeOutcome, { kind: "handled", text: "Sure, here it is." });
  assert.equal((await listSlotFiles(userId, 1)).length, 1);
  assert.equal(await shouldEnableCwc(userId, true, "hello there"), true);

  const readResponse = [
    "<<<CHROMIX_ACTION_START:READ_FILE>>>",
    "[PATH: hello.py]",
    "[LINES: 1-1]",
    "<<<CHROMIX_ACTION_END>>>",
  ].join("\n");

  const readOutcome = await applyCwcResponse(userId, readResponse, state);
  assert.equal(readOutcome.kind, "continue");
  if (readOutcome.kind !== "continue") return;
  assert.match(readOutcome.notice, /workspace/);
  assert.equal(state.feedbackTurns, 1);
  assert.match(state.feedback, /print\('hi'\)/);
  assert.match(state.feedback, /untrusted/i);
  assert.match(state.feedback, /<<<CWC_RESULT_END:[0-9a-f]+>>>/);
  assert.match(String(state.workspaceSummary), /hello\.py/);

  const finalOutcome = await applyCwcResponse(userId, "It prints hi.", state);
  assert.deepEqual(finalOutcome, { kind: "none" });

  const footer = formatCwcOperationResults(state.operations, state.workspace);
  assert.match(footer, /CWC — Workspace 1 \(slot 1\)/);
  assert.match(footer, /Created `hello\.py`/);
  assert.doesNotMatch(footer, /\[READ /);
  assert.equal(footer.includes("<@"), false);

  state.feedbackTurns = MAX_CWC_FEEDBACK_TURNS;
  const capped = await applyCwcResponse(userId, readResponse, state);
  assert.deepEqual(capped.kind, "handled");
  if (capped.kind !== "handled") return;
  assert.match(capped.text, /stopped after reading/);

  await cleanupUser(userId);
});

test("sanitizes mention payloads from workspace file operations in the footer", async () => {
  const userId = `e2e-cwc-footer-${Date.now()}`;
  await prepareUser(userId);

  const state = await createCwcLoopState(userId);
  const outcome = await applyCwcResponse(userId, [
    "<<<CHROMIX_ACTION_START:WRITE_FILE>>>",
    "[PATH: @everyone.py]",
    "[CONTENT]",
    "print('hi')",
    "<<<CHROMIX_ACTION_END>>>",
  ].join("\n"), state);

  assert.equal(outcome.kind, "handled");
  const footer = formatCwcOperationResults(state.operations, state.workspace);
  assert.equal(footer.includes("@everyone"), false);
  assert.match(footer, /@\u200beveryone\.py/);
  assert.match(footer, /Created `@\u200beveryone\.py`/);

  await cleanupUser(userId);
});
