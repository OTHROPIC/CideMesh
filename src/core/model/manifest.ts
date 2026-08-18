/**
 * SlideMesh middleware manifest — DRAFT for review, not yet implemented.
 *
 * On disk:
 *
 *   workspace/
 *     manifest.json   this structure — ours
 *     res/            the unzipped .pptx, every part verbatim — theirs
 *       [Content_Types].xml
 *       _rels/
 *       ppt/
 *       docProps/
 *
 * The split is what makes re-packaging trivial and safe: zipping a workspace back
 * into a `.pptx` is "zip res/", with nothing to exclude by name and no chance that a
 * deck legitimately containing a root `manifest.json` collides with ours. It also
 * makes it obvious at a glance which bytes are the user's original and which are
 * ours. `PartRecord.path` stays archive-relative; joining it to disk is a single
 * constant prefix.
 *
 * PATHS ARE ALWAYS RELATIVE. The workspace is a user-owned document that can be
 * moved, copied, or committed to version control, so an absolute path stored
 * anywhere in this structure is a bug.
 *
 * Answers, at any moment: what did we model, what did we NOT model, and where did
 * each modeled thing come from. Export is one-way and lossy, so this — not the
 * exported deck — is the durable record of the user's work.
 *
 * THREE RULES THE SHAPE ENCODES
 *   1. Source is immutable. `SourceRef` is written once at ingest and never edited;
 *      `layout`/`style` hold everything the user authors. Resolved geometry is
 *      computed per render and never stored at all.
 *   2. The tree is flat and parent-pointed. A reparent writes one record.
 *   3. Loss is ledgered at ingest, not discovered at export.
 *
 * EXTENSIBILITY: `schemaVersion` bumps only on breaking changes; string unions are
 * open so unknown values survive a round trip; `ext` bags must be preserved on save
 * even when unrecognized.
 *
 * UNITS: source geometry is EMU (914400/inch, as PPTX stores it). Authored sizes are
 * CSS strings ("50%", "1fr", "auto", "24pt", "120px") because the browser resolves
 * layout and we hand the result to the exporter. Fixed px converts at 9525 EMU/px.
 */

export type SchemaVersion = 1;

/** Namespaced extension data. Preserve on read/write even when unrecognized. */
export type Ext = Record<string, unknown>;

export interface SlideMeshManifest {
  schemaVersion: SchemaVersion;

  source: {
    /** Display name of the originating deck, e.g. "Q3 review.pptx". Never a path. */
    fileName: string;
    /**
     * Where the originating `.pptx` sits, **relative to this file's directory**
     * (e.g. "../Q3 review.pptx"). Optional and advisory: it is a convenience for
     * "reveal the original", not a dependency — the unzipped parts already contain
     * everything we need. Omitted when the source is outside the workspace's tree,
     * because an absolute path must never be written here.
     */
    relPath?: string;
    /** Identity of the source deck. This, not a path, is how the original is recognized. */
    sha256: string;
    byteLength: number;
    importedAt: string; // ISO 8601
    slideSize: { cx: number; cy: number }; // EMU; the default export target
  };

  /** Export ratios the user has defined, keyed by id. Any size is permitted. */
  targets: Record<string, { label: string; cx: number; cy: number }>;

  /**
   * Named styles shared by reference, deck-wide. The batch-edit mechanism: editing
   * one entry restyles every node pointing at it ("every title to 32pt"). Also how
   * per-container regional masks stay identical.
   */
  styles: Record<string, Style>;

  parts: PartRecord[];
  slides: SlideRecord[];
  tree: TreeItemRecord[];
  unmodeled: UnmodeledRecord[];
  lastExport?: ExportRecord;
  ext?: Ext;
}

// ─── Archive ──────────────────────────────────────────────────────────────────

export interface PartRecord {
  /**
   * The OOXML part path, e.g. "ppt/slides/slide1.xml" — exactly as the archive
   * names it, so re-packaging needs no rewriting. On disk it lives at `res/<path>`.
   * Always relative, always forward slashes.
   */
  path: string;
  contentType: string;
  sha256: string;
  byteLength: number;
  /**
   * modeled     — parsed into the tree
   * referenced  — not parsed but pointed at by something modeled (e.g. an image)
   * passthrough — carried in the workspace, irrelevant to the model
   * unmodeled   — meaningful content we cannot represent; has an UnmodeledRecord
   */
  role: 'modeled' | 'referenced' | 'passthrough' | 'unmodeled';
  /** r:id → target path or URL. */
  rels?: Record<string, string>;
  ext?: Ext;
}

export interface SlideRecord {
  slideId: string;
  partPath: string;
  index: number;
  /** Exactly one virtual root container per slide — never a forest. */
  rootNodeId: string;
  /**
   * Layout name and type from the layout part. With `ShapeNodeData.placeholder`,
   * this is what lets a batch edit be scoped the way users describe it — "every
   * title on every content slide" — without hand-tagging.
   */
  layoutName?: string;
  layoutType?: string;
  notesPartPath?: string;
  ext?: Ext;
}

// ─── Tree ─────────────────────────────────────────────────────────────────────

/**
 * Flat adjacency, parent-pointer canonical. No `children` array: that would store
 * each relationship twice and make a move rewrite two records. `children` is derived
 * in memory at load (group by `parent`, sort by `order`) for react-complex-tree.
 *
 * Invariants checked at load: exactly one node per slide with `parent === null`;
 * no cycles (parent pointers permit them); every `parent` resolves; `order` unique
 * among siblings.
 */
export interface TreeItemRecord {
  index: string; // node id; matches data.id
  parent: string | null; // null only for a slide's virtual root
  /**
   * Fractional rank among siblings: a base-62 string compared lexicographically, so
   * an insert between "a0" and "a1" yields "a0V" and renumbers nobody. Keys grow by
   * ~1 char per interleave into the same gap, so a compaction pass reassigns
   * evenly spaced minimum-width keys per sibling group at save time.
   */
  order: string;
  isFolder: boolean;
  canMove: boolean;
  data: ShapeNodeData;
}

export interface ShapeNodeData {
  id: string;
  name: string;
  /**
   * 'root' and 'group' are container variants: 'root' is the synthetic per-slide
   * container, 'group' mirrors a p:grpSp from the deck, 'container' is authored by
   * the user. Open union — new element kinds must not break older readers.
   */
  type: 'root' | 'container' | 'group' | 'shape' | 'text' | 'image' | (string & {});
  /** Stacking devices rather than content. 'guide' never exports. */
  role?: 'content' | 'mask' | 'backdrop' | 'guide';
  isVisible: boolean;

  /** Absent for authored containers, which no source shape backs. Immutable. */
  source?: SourceRef;

  /**
   * Stacking rank among SIBLINGS, not across the slide. Masks are regional — one per
   * container, sharing a style — so containment and stacking coincide and containers
   * may freely use opacity/transform/filter. Accepted limit: a node cannot paint
   * between two children of a container it does not belong to.
   * Seeded from `source.z`. Global paint order = depth-first walk honoring this.
   */
  z: number;
  opacity?: number; // 0..1

  /** The deck's own p:ph tag ("title", "ctrTitle", "body"...). Read, never invented. */
  placeholder?: { type: string; idx?: number };

  /** Authored layout. Seeded at ingest as mode:'absolute' from source bounds. */
  layout: LayoutSpec;
  /** Sparse per-target deviations, keyed by target id. Missing = layout unchanged. */
  overrides?: Record<string, Partial<LayoutSpec>>;

  /** Exactly one — that is what keeps the style view a tree rather than a graph. */
  styleRef?: string;
  /** Per-node deviations from the referenced style. Keep rare. */
  styleOverrides?: Partial<Style>;

  altText?: string;
  ext?: Ext;
}

/**
 * Layer 1: the source deck's truth about a shape — provenance and geometry together,
 * since neither exists without the other. Written once at ingest, never edited.
 * Keeping it separate from `layout` is what preserves reset-to-original and gives
 * the fidelity test something to measure export against.
 */
export interface SourceRef {
  partPath: string;
  spid: number; // p:cNvPr/@id — unique within its slide, not globally
  xpath: string;
  /** Byte offsets within the part, for a future surgical writer. Valid while sha256 holds. */
  xmlByteRange?: { start: number; end: number };

  bounds: { x: number; y: number; width: number; height: number }; // EMU
  z: number; // paint order as declared
  rotation?: number; // degrees
  flipH?: boolean;
  flipV?: boolean;
  opacity?: number;
}

/**
 * Layer 2: authored reflow intent. Deliberately small — not a mirror of CSS. Item
 * properties and container properties share one type; container ones are meaningful
 * only when `display` is set. All sizes are CSS strings.
 */
export interface LayoutSpec {
  /** 'absolute' pins within the parent (the ingest default); 'flow' hands position
   *  to the parent's display rules — the point of the product. */
  mode: 'absolute' | 'flow';

  // As an item
  width?: string;
  height?: string;
  minWidth?: string;
  minHeight?: string;
  maxWidth?: string;
  maxHeight?: string;
  aspectLock?: boolean; // preserve source ratio while reflowing; matters for images
  align?: 'start' | 'center' | 'end' | 'stretch'; // align-self in flow
  grow?: number; // flex-grow
  order?: number; // defaults to tree order
  gridArea?: string; // e.g. "1 / 3"
  margin?: string; // CSS shorthand

  // As a container
  display?: 'flex' | 'grid' | 'block';
  direction?: 'row' | 'column';
  wrap?: boolean;
  gap?: string;
  padding?: string;
  justify?: 'start' | 'center' | 'end' | 'stretch' | 'space-between' | 'space-around';
  alignItems?: 'start' | 'center' | 'end' | 'stretch';
  templateColumns?: string;
  templateRows?: string;

  ext?: Ext;
}

/**
 * A named appearance. Surface properties plus the typography that batch edits
 * actually target. Richer source fills ledger as unmodeled rather than being
 * half-represented.
 */
export interface Style {
  name: string; // "Title", "Body copy", "Dim mask"
  fill?: string; // CSS color incl. alpha, "#00000080"
  opacity?: number;
  cornerRadius?: string;
  border?: string; // CSS shorthand
  backdropBlur?: string; // the usual mask mechanism
  shadow?: string;
  fontFamily?: string;
  fontSize?: string; // "24pt", or "%" to scale with the target ratio
  fontWeight?: number;
  italic?: boolean;
  lineHeight?: number;
  letterSpacing?: string;
  color?: string;
  textAlign?: 'left' | 'center' | 'right' | 'justify';
  textTransform?: 'none' | 'uppercase' | 'capitalize';
  ext?: Ext;
}

// ─── Loss ledger ──────────────────────────────────────────────────────────────

/**
 * Written at ingest, not discovered at export. Drives the fidelity baseline, the
 * pre-export warning, and the "no silent drops" test assertion.
 */
export interface UnmodeledRecord {
  /** theme | slideMaster | slideLayout | notes | chart | smartArt | oleObject |
   *  animation | transition | media | customXml | unsupportedShape | unknown.
   *  Open: unrecognized kinds round-trip rather than failing to parse. */
  kind: string;
  partPath: string;
  slideId?: string;
  spid?: number;
  reason: string; // human-readable; surfaced in the export warning
  /** cosmetic — styling drift; contentLoss — visible content absent;
   *  blocking — export would misrepresent the deck, warn before writing. */
  severity: 'cosmetic' | 'contentLoss' | 'blocking';
  /** True if the workspace still holds enough for a future writer to carry it through. */
  restorable: boolean;
  ext?: Ext;
}

// ─── Export ───────────────────────────────────────────────────────────────────

/** Written after each export so fidelity is tracked over time, not measured once. */
export interface ExportRecord {
  exportedAt: string;
  outputPath: string;
  targetId: string; // fidelity numbers are meaningless without the target
  writer: string; // "dom-to-pptx"
  writerVersion: string;
  /** Reparse of our own output against `tree`. Leaf geometry and content only —
   *  hierarchy is flattened by the writer and cannot be verified this way. */
  fidelity?: {
    shapesIn: number;
    shapesOut: number;
    maxPositionDriftEmu: number;
    textMismatches: number;
    droppedSpids: number[];
  };
  ext?: Ext;
}
