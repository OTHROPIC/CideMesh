/**
 * Fractional order keys — DRAFT contract, not yet implemented.
 *
 * `TreeItemRecord.order` ranks a node among its siblings. Keys are base-62 strings
 * compared with plain lexicographic `<`, so ordering never depends on parsing them
 * as numbers, and inserting between "a0" and "a1" yields "a0V" without renumbering
 * anyone. That is what makes a reparent or reorder a one-record write.
 *
 * Kept separate from manifest.ts because this is behavior, not shape: the manifest
 * defines what is stored, this defines the algebra over one of its fields.
 */

import type { TreeItemRecord } from './manifest';

/**
 * Compaction threshold. Keys grow about one character per interleave into the same
 * gap, so a group that has been dragged back and forth repeatedly eventually bloats
 * the manifest and stops being readable in a diff.
 */
export const MAX_ORDER_KEY_LENGTH = 12;

/**
 * A key strictly between `a` and `b`, shortest available. `null` means open-ended:
 * keyBetween(null, first) prepends, keyBetween(last, null) appends.
 */
export declare function keyBetween(a: string | null, b: string | null): string;

/** True when a sibling group has drifted past MAX_ORDER_KEY_LENGTH. */
export declare function needsCompaction(siblings: TreeItemRecord[]): boolean;

/**
 * Reassign evenly spaced, minimum-width keys across ONE sibling group, preserving
 * their current order exactly. Returns only the records whose key actually changed,
 * so the caller can write a minimal patch.
 *
 * Scoped to a single group by design: compacting the whole tree would rewrite every
 * record and produce a diff that buries the user's real edit.
 *
 * Policy — run at save time, never mid-drag (rewriting keys under an in-flight
 * drag-and-drop would move rows beneath the user's cursor), and on an explicit
 * "tidy" command. Order-preserving and idempotent: compacting twice changes nothing
 * the second time, and no node ever moves relative to its siblings.
 *
 * Safe because nothing outside the tree references `order` — every cross-link in the
 * manifest uses node ids — so rewriting keys invalidates nothing.
 */
export declare function compactSiblings(
  siblings: TreeItemRecord[],
): Array<{ index: string; order: string }>;
