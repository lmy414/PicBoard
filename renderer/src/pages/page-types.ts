import type { AppState } from "../../../shared/image-board";

/** Save indicator shown in the content page header. */
export type SaveStatus = "saved" | "saving" | "error";

/** Mutable flag shared with kind pages so a removed content is never re-saved. */
export interface ContentLifecycle {
  discard: boolean;
}

/** Imperative hooks a kind page registers with the page shell. */
export interface ContentPageApi {
  /** Unsaved image edits can ask before leaving the page. */
  beforeClose?: () => boolean | Promise<boolean>;
  /** Persist pending edits; resolves when the save attempt settled. */
  flush?: () => void | Promise<void>;
  /** Close page-owned popups (link editor, bubble URL input); true when one closed. */
  closePopups?: () => boolean;
}

/** Host callbacks shared by text and link pages. */
export interface ContentPageCallbacks {
  onState(state: AppState): void;
  onError(message: string): void;
  onNotice(message: string): void;
  onSaveStatus(status: SaveStatus): void;
}
