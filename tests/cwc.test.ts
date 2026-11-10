import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import { test } from "node:test";
import { hasCwcIntent, parseCwcActions } from "../src/logic.js";
import {
  clearSlot,
  createWorkspaceZip,
  deleteUserWorkspaces,
  deleteSlotFile,
  ensureUserSlots,
  executeCwcActions,
  formatCwcOperationResults,
  getActiveSlot,
  getWorkspaceSummary,
  listSlotFiles,
  readSlotFile,
  renameSlot,
  resolveSafePath,
  setActiveSlot,
  workspaceHasFiles,
  writeSlotFile,
  MAX_FILES_PER_SLOT,
} from "../src/services/cwc.js";

test("parses CWC write_file and read_file actions and strips them from cleanText", () => {
  const raw = [
    "Here is the fixed file for you:",
    "<<<CHROMIX_ACTION_START:WRITE_FILE>>>",
    "[PATH: test.py]",
    "[CONTENT]",
    "def hello():",
    "    return 'world'",
    "<<<CHROMIX_ACTION_END>>>",
    "Let me know if you need anything else!",
  ].join("\n");

  const { actions, cleanText } = parseCwcActions(raw);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, "write_file");
  if (actions[0].type === "write_file") {
    assert.equal(actions[0].path, "test.py");
    assert.equal(actions[0].content, "def hello():\n    return 'world'");
  }
  assert.ok(cleanText.includes("Here is the fixed file for you:"));
  assert.ok(cleanText.includes("Let me know if you need anything else!"));
  assert.ok(!cleanText.includes("CHROMIX_ACTION_START"));
});

test("parses CWC read_file with line ranges", () => {
  const raw = [
    "<<<CHROMIX_ACTION_START:READ_FILE>>>",
    "[PATH: src/index.ts]",
    "[LINES: 10-25]",
    "<<<CHROMIX_ACTION_END>>>",
  ].join("\n");

  const { actions, cleanText } = parseCwcActions(raw);
  assert.equal(actions.length, 1);
  assert.deepEqual(actions[0], {
    type: "read_file",
    path: "src/index.ts",
    startLine: 10,
    endLine: 25,
  });
  assert.equal(cleanText, "");
});

test("blocks directory traversal attempts in resolveSafePath", () => {
  const base = "C:\\test\\dir";
  assert.throws(() => resolveSafePath(base, "../evil.txt"), /Invalid or unsafe path|Path traversal/);
  assert.throws(() => resolveSafePath(base, "sub/../../evil.txt"), /Invalid or unsafe path|Path traversal/);
  assert.throws(() => resolveSafePath(base, "\0null.txt"), /Invalid or unsafe path/);
});

test("blocks sibling paths that only share a prefix with the slot directory", () => {
  const base = resolve("data", "workspaces", "user", "slot_1");
  const siblingFile = resolve(`${base}-evil`, "escape.txt");
  assert.throws(() => resolveSafePath(base, siblingFile), /Path traversal/);
});

test("parses delete and list actions and drops unsafe paths", () => {
  const raw = [
    "<<<CHROMIX_ACTION_START:LIST_FILES>>>",
    "<<<CHROMIX_ACTION_END>>>",
    "<<<CHROMIX_ACTION_START:DELETE_FILE>>>",
    "[PATH: old.py]",
    "<<<CHROMIX_ACTION_END>>>",
    "<<<CHROMIX_ACTION_START:READ_FILE>>>",
    "[PATH: ../evil.txt]",
    "<<<CHROMIX_ACTION_END>>>",
  ].join("\n");
  const { actions, cleanText } = parseCwcActions(raw);
  assert.deepEqual(actions, [{ type: "list_files" }, { type: "delete_file", path: "old.py" }]);
  assert.equal(cleanText, "");
});

test("detects CWC intent without activating on casual chat", () => {
  assert.equal(hasCwcIntent("fix the bug in calculator.py"), true);
  assert.equal(hasCwcIntent("what's the weather today?"), false);
  assert.equal(hasCwcIntent("write a poem about the sea"), false);
});

test("manages workspace slots, writes, reads, and zips files", async () => {
  const testUser = "test_user_cwc_9999";
  await ensureUserSlots(testUser);
  await clearSlot(testUser, 1);
  await clearSlot(testUser, 2);

  const active = await getActiveSlot(testUser);
  assert.equal(active.slot, 1);

  // Write file in slot 1
  const writeRes = await writeSlotFile(testUser, "main.py", "print('hello from cwc')\nprint('line 2')");
  assert.equal(writeRes.isNew, true);
  assert.equal(writeRes.lineCount, 2);

  // Read file full
  const readRes = await readSlotFile(testUser, "main.py");
  assert.equal(readRes.totalLines, 2);
  assert.ok(readRes.content.includes("hello from cwc"));

  // Read file line slice
  const sliceRes = await readSlotFile(testUser, "main.py", 1, 1);
  assert.equal(sliceRes.content, "print('hello from cwc')");

  // List files
  const files = await listSlotFiles(testUser);
  assert.equal(files.length, 1);
  assert.equal(files[0].name, "main.py");

  // Switch to slot 2 and verify isolation
  await setActiveSlot(testUser, 2);
  const active2 = await getActiveSlot(testUser);
  assert.equal(active2.slot, 2);
  const filesSlot2 = await listSlotFiles(testUser, 2);
  assert.equal(filesSlot2.length, 0);

  // Rename slot 2
  const newName = await renameSlot(testUser, 2, "My Bot Project");
  assert.equal(newName, "My Bot Project");

  // Switch back to slot 1 and generate zip
  await setActiveSlot(testUser, 1);
  const zipBuffer = await createWorkspaceZip(testUser);
  assert.ok(Buffer.isBuffer(zipBuffer));
  assert.ok(zipBuffer.length > 50);

  // Delete file
  await deleteSlotFile(testUser, "main.py");
  const filesAfterDelete = await listSlotFiles(testUser);
  assert.equal(filesAfterDelete.length, 0);

  // Cleanup
  await clearSlot(testUser, 1);
  await clearSlot(testUser, 2);
});

test("executes parsed actions and feeds read results back to the model", async () => {
  const testUser = "test_user_cwc_exec";
  await ensureUserSlots(testUser);
  await setActiveSlot(testUser, 1);
  await clearSlot(testUser, 1);

  const writeExecution = await executeCwcActions(testUser, [
    { type: "write_file", path: "app.py", content: "print('hi')\nprint('bye')" },
  ]);
  assert.equal(writeExecution.needsModelTurn, false);
  assert.equal(writeExecution.feedback, "");
  assert.equal(writeExecution.results[0].ok, true);
  assert.match(formatCwcOperationResults(writeExecution.results, writeExecution.workspace), /Created `app\.py`/);

  const readExecution = await executeCwcActions(testUser, [
    { type: "read_file", path: "app.py", startLine: 1, endLine: 1 },
  ]);
  assert.equal(readExecution.needsModelTurn, true);
  assert.match(readExecution.feedback, /UNTRUSTED|untrusted/);
  assert.ok(readExecution.feedback.includes("print('hi')"));
  assert.ok(!readExecution.feedback.includes("print('bye')"));
  assert.match(readExecution.feedback, /CWC_RESULT_END:[0-9a-f]+/);
  assert.equal(formatCwcOperationResults(readExecution.results, readExecution.workspace), "");

  const listExecution = await executeCwcActions(testUser, [{ type: "list_files" }]);
  assert.equal(listExecution.needsModelTurn, true);
  assert.ok(listExecution.feedback.includes("app.py"));

  const escapeExecution = await executeCwcActions(testUser, [{ type: "read_file", path: "../secret.txt" }]);
  assert.equal(escapeExecution.results[0].ok, false);
  assert.equal(escapeExecution.needsModelTurn, true);

  const deleteExecution = await executeCwcActions(testUser, [{ type: "delete_file", path: "app.py" }]);
  assert.equal(deleteExecution.results[0].ok, true);
  assert.equal(deleteExecution.needsModelTurn, false);

  await deleteUserWorkspaces(testUser);
  assert.equal(workspaceHasFiles(testUser), false);
});

test("escapes workspace names in the prompt summary", async () => {
  const testUser = "test_user_cwc_summary";
  await ensureUserSlots(testUser);
  await setActiveSlot(testUser, 1);
  await clearSlot(testUser, 1);
  await renameSlot(testUser, 1, '<evil>"name');
  await writeSlotFile(testUser, "a.py", "print(1)");

  const summary = await getWorkspaceSummary(testUser);
  assert.ok(summary.includes("&lt;evil&gt;&quot;name"));
  assert.ok(!summary.includes('<evil>"name'));
  assert.ok(summary.includes("a.py"));

  await deleteUserWorkspaces(testUser);
  assert.equal(workspaceHasFiles(testUser), false);
});


test("enforces slot file count and size limits", async () => {
  const testUser = "test_user_cwc_limits";
  await ensureUserSlots(testUser);
  await clearSlot(testUser, 1);

  // Exceeding 2MB size limit
  const hugeContent = "x".repeat(2 * 1024 * 1024 + 10);
  await assert.rejects(
    async () => await writeSlotFile(testUser, "huge.txt", hugeContent),
    /exceeds maximum allowed size/
  );

  // Fill up to max 10 files
  for (let i = 1; i <= MAX_FILES_PER_SLOT; i++) {
    await writeSlotFile(testUser, `file_${i}.py`, `print(${i})`);
  }
  const files = await listSlotFiles(testUser);
  assert.equal(files.length, 10);

  // 11th file should be rejected
  await assert.rejects(
    async () => await writeSlotFile(testUser, "file_11.py", "print(11)"),
    /Workspace slot limit reached/
  );

  // Overwriting an existing file among the 10 should succeed
  const overwriteRes = await writeSlotFile(testUser, "file_1.py", "print('updated')");
  assert.equal(overwriteRes.isNew, false);

  await clearSlot(testUser, 1);
});

