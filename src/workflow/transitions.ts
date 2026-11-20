import type { WorkflowState } from './types.js';

/**
 * The transitions of a workflow.
 *
 * A workflow moves through its states in a fixed order, and every step of it
 * is recorded. A transition that is not listed here is a bug of the workflow,
 * not a state the workflow may reach: the states are the contract between the
 * steps, and a step that skips one leaves a record that nobody can read.
 */
const TRANSITIONS: Record<WorkflowState, WorkflowState[]> = {
  created: ['issue-loaded', 'blocked', 'cancelled'],
  'issue-loaded': ['worktree-created', 'blocked', 'cancelled'],
  'worktree-created': ['implementation-running', 'blocked', 'cancelled'],
  'implementation-running': ['awaiting-review', 'blocked', 'cancelled'],
  'awaiting-review': ['review-running', 'blocked', 'cancelled'],
  'review-running': ['completed', 'fixes-requested', 'blocked', 'cancelled'],
  'fixes-requested': ['implementation-running', 'blocked', 'cancelled'],
  completed: [],
  blocked: [],
  cancelled: [],
};

/** The states a workflow cannot leave. */
export function isTerminal(state: WorkflowState): boolean {
  return TRANSITIONS[state].length === 0;
}

/** Whether a workflow may move from one state to another. */
export function canTransition(from: WorkflowState, to: WorkflowState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Refuse a transition a workflow may not make. */
export function assertTransition(from: WorkflowState, to: WorkflowState): void {
  if (!canTransition(from, to)) {
    throw new Error(`The workflow cannot move from '${from}' to '${to}'.`);
  }
}
