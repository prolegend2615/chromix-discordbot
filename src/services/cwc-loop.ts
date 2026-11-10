import { hasCwcIntent, parseCwcActions } from "../logic.js";
import {
  executeCwcActions,
  getWorkspaceSummary,
  workspaceHasFiles,
  type CwcActionResult,
} from "./cwc.js";

export const MAX_CWC_FEEDBACK_TURNS = 3;

export interface CwcLoopState {
  workspaceSummary?: string;
  feedback: string;
  feedbackTurns: number;
  operations: CwcActionResult[];
  workspace?: { slot: number; name: string };
}

export type CwcResponseOutcome =
  | { kind: "continue"; notice: string }
  | { kind: "handled"; text: string }
  | { kind: "none" };

/** CWC should only be injected when the user is VIP and the turn is workspace-relevant. */
export async function shouldEnableCwc(userId: string, vip: boolean, prompt: string, adminChat: boolean): Promise<boolean> {
  return !adminChat && vip && (hasCwcIntent(prompt) || workspaceHasFiles(userId));
}

export async function createCwcLoopState(userId: string): Promise<CwcLoopState> {
  return {
    workspaceSummary: await getWorkspaceSummary(userId),
    feedback: "",
    feedbackTurns: 0,
    operations: [],
    workspace: undefined,
  };
}

/**
 * Applies one model response to the workspace. Returns "continue" when the model
 * asked to read/list and another turn is allowed, "handled" when the response
 * should be posted as-is, or "none" when the caller should keep the raw response.
 */
export async function applyCwcResponse(
  userId: string,
  response: string,
  state: CwcLoopState,
): Promise<CwcResponseOutcome> {
  const parsed = parseCwcActions(response);
  if (!parsed.actions.length) {
    return parsed.cleanText !== response ? { kind: "handled", text: parsed.cleanText } : { kind: "none" };
  }

  const execution = await executeCwcActions(userId, parsed.actions);
  state.operations.push(...execution.results);
  state.workspace = execution.workspace;

  if (execution.needsModelTurn && state.feedbackTurns < MAX_CWC_FEEDBACK_TURNS) {
    state.feedbackTurns += 1;
    state.feedback = execution.feedback;
    state.workspaceSummary = await getWorkspaceSummary(userId);
    return { kind: "continue", notice: "Reading your workspace files…" };
  }

  return {
    kind: "handled",
    text: parsed.cleanText || (execution.needsModelTurn
      ? "I stopped after reading your workspace files. Ask me to continue if you need more."
      : "Done."),
  };
}
