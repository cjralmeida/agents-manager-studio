/** Provider-neutral shapes shared by the GitHub and GitLab board adapters. */

import type { BoardStructure, FieldOrder } from './structure.js';

export const STATUS_ROLES = ['todo', 'inProgress', 'review', 'homologation', 'done', 'blocked'] as const;
export type StatusRole = (typeof STATUS_ROLES)[number];
/** Column id for each role; a role may be unmapped. */
export type StatusMap = Partial<Record<StatusRole, string>>;

export interface BoardOption {
  id: string;
  name: string;
  /** Hex color (#rrggbb). */
  color: string;
  description: string | null;
}

export interface BoardField {
  id: string;
  name: string;
  options: BoardOption[];
}

export interface BoardPullRequest {
  url: string;
  number: number;
  state: string;
}

export interface BoardItem {
  /** Adapter-specific id used to update the item. */
  id: string;
  title: string;
  body: string;
  url: string | null;
  number: number | null;
  /** Repository path (e.g. GlobalFarm-Hub/automacoes, group/sub/repo); null for drafts. */
  repository: string | null;
  isDraft: boolean;
  isClosed: boolean;
  columnId: string | null;
  /** Selected option id per field id. */
  fields: Record<string, string>;
  assignees: string[];
  pullRequests: BoardPullRequest[];
  updatedAt: string;
  /** On the joined workspace board: the source (task_boards row) the task comes from. */
  sourceId?: string;
}

export interface BoardSnapshot {
  title: string;
  url: string;
  readme: string | null;
  columns: BoardOption[];
  /** GitHub: id of the single-select field that holds the columns. */
  statusFieldId: string | null;
  fields: BoardField[];
  items: BoardItem[];
  /** Board can create items without a repository (GitHub drafts). */
  supportsDrafts: boolean;
  /**
   * Repositories whose open issues are all on the board (a GitLab group board loads every open issue, but only the
   * recently closed ones): a task of theirs that is not on the board was closed long ago.
   */
  allOpenListed?: string[];
}

/** A board found while detecting, or resolved from a URL, before it is linked. */
export interface BoardCandidate {
  externalId: string;
  ownerPath: string;
  title: string;
  url: string;
  /** Looks like it was made from the Studio template. */
  matchesTemplate: boolean;
}

export interface BoardRef {
  host: string;
  externalId: string;
  ownerPath: string;
}

export interface NewTask {
  title: string;
  body: string;
  /** Repository path; null creates a draft where supported. */
  repository: string | null;
  columnId: string | null;
  fields: Record<string, string>;
}

export interface ItemComment {
  author: string;
  /** ISO date. */
  at: string;
  body: string;
}

export interface BoardAdapter {
  load(board: BoardRef & { readme: string | null; fieldOrder: FieldOrder | null }): Promise<BoardSnapshot>;
  moveItem(board: BoardRef, snapshot: BoardSnapshot, itemId: string, columnId: string): Promise<void>;
  setItemField(board: BoardRef, snapshot: BoardSnapshot, itemId: string, fieldId: string, optionId: string | null): Promise<void>;
  createTask(board: BoardRef, snapshot: BoardSnapshot, task: NewTask): Promise<BoardItem>;
  /** Changes the title and/or description of the item's issue (or draft). */
  editItem(board: BoardRef, snapshot: BoardSnapshot, itemId: string, changes: { title?: string; body?: string }): Promise<void>;
  /** Assigns the token's user to the item's issue (no-op for drafts). */
  assignSelf(board: BoardRef, itemId: string): Promise<void>;
  /** Replaces the people assigned to the item's issue (logins/usernames on the provider; empty removes everyone). */
  setAssignees(board: BoardRef, itemId: string, usernames: string[]): Promise<void>;
  /** Closes or reopens the item's issue. */
  setClosed(board: BoardRef, itemId: string, closed: boolean): Promise<void>;
  /** Comments on the item's issue (a Studio task keeps it at the end of its description). */
  addComment(board: BoardRef, itemId: string, body: string): Promise<void>;
  /** The item's latest comments, oldest first (system notes left out; none for drafts and Studio tasks). */
  listComments(board: BoardRef, itemId: string, limit: number): Promise<ItemComment[]>;
  /** Makes the board columns and fields match `desired` (ids from `current` are kept; cards were already moved). */
  applyStructure(board: BoardRef, current: BoardStructure, desired: BoardStructure): Promise<void>;
}
