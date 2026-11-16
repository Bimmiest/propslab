import { useId, useMemo, useState } from 'react';
import {
  OCSF_VERSION,
  validateOcsfCoverage,
  type OcsfAttributeCoverage,
  type OcsfClass,
  type OcsfConstraintCoverage,
} from 'propslab-engine';
import { useAppStore } from '../../../store/useAppStore';
import { ProgressBar } from '../../ui/ProgressBar';
import { Icon } from '../../ui/Icon';
import { Badge } from '../../ui/Badge';
import { Identifier } from '../../ui/Identifier';
import { copyQuietly } from '../../../utils/clipboard';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuTrigger,
} from '../../ui/ContextMenu';
import {
  declaredClassUids,
  OCSF_MATCH_THRESHOLD_PERCENT,
  rankClasses,
  type OcsfFit,
} from '../../../utils/ocsfMatching';
import { useApplyDirective } from './shared/useApplyDirective';

/** The class matches the text of the filter: its caption, name, category or class_uid. */
function matchesFilter(ocsfClass: OcsfClass, filter: string): boolean {
  const text = filter.trim().toLowerCase();
  if (text === '') return true;
  return [ocsfClass.caption, ocsfClass.name, ocsfClass.categoryCaption, String(ocsfClass.uid)].some((s) =>
    s.toLowerCase().includes(text),
  );
}

/** The OCSF view of the Schemas tab (#892): the extracted fields against each OCSF event class. */
export function OcsfClassesTab() {
  const result = useAppStore((s) => s.processingResult);
  const [showMatchingOnly, setShowMatchingOnly] = useState(false);
  const [filter, setFilter] = useState('');

  const fits = useMemo(() => {
    const names = result?.fieldStats.names ?? [];
    return rankClasses(validateOcsfCoverage(names), declaredClassUids(result?.events ?? [], names));
  }, [result]);

  const matchingCount = useMemo(() => fits.filter((f) => f.matches).length, [fits]);
  // With no matching class the toggle is hidden, so a filter left on must not empty the list.
  const onlyMatching = showMatchingOnly && matchingCount > 0;
  const shown = fits.filter((f) => (!onlyMatching || f.matches) && matchesFilter(f.result.ocsfClass, filter));

  return (
    <div className="h-full overflow-auto p-3 space-y-3">
      <div className="text-xs text-[var(--color-text-muted)]">
        {matchingCount > 0
          ? `${matchingCount} matching class${matchingCount !== 1 ? 'es' : ''} of ${fits.length}`
          : `${fits.length} classes, none matches yet`}
        {`. A match has ${OCSF_MATCH_THRESHOLD_PERCENT}% or more of the required attributes that the class does not take from the base event, or a class_uid field with its uid. Best fit first. `}
        {`OCSF ${OCSF_VERSION}: this view checks that an attribute is present, not its value, and leaves out profiles and extensions.`}
      </div>
      <div className="flex items-center gap-3">
        <input
          type="search"
          aria-label="Filter the classes"
          placeholder="Filter by name, category or class_uid"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="flex-1 min-w-0 px-2 py-1 text-xs rounded border border-[var(--color-border-control)] bg-[var(--color-bg-elevated)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]"
        />
        {matchingCount > 0 && (
          <button
            type="button"
            aria-pressed={showMatchingOnly}
            onClick={() => setShowMatchingOnly(!showMatchingOnly)}
            className={`shrink-0 text-xs text-[var(--color-accent)] hover:underline cursor-pointer ${showMatchingOnly ? 'font-semibold underline' : ''}`}
          >
            Show matching only
          </button>
        )}
      </div>

      {shown.length === 0 && <div className="text-xs text-[var(--color-text-muted)]">No class matches the filter.</div>}
      {shown.map((fit) => (
        <OcsfClassCard key={fit.result.ocsfClass.uid} fit={fit} />
      ))}
    </div>
  );
}

function OcsfClassCard({ fit }: { fit: OcsfFit }) {
  const [expanded, setExpanded] = useState(false);
  const [showOptional, setShowOptional] = useState(false);
  const { result } = fit;
  const { ocsfClass } = result;
  const hasMatches = fit.keyPresent.length > 0 || fit.declared;
  const variant = result.requiredPercent >= 80 ? 'success' : result.requiredPercent >= 40 ? 'warning' : 'error';
  const optional = result.attributes.filter((a) => a.requirement === 'optional');

  return (
    <div className="border border-[var(--color-border)] rounded bg-[var(--color-bg-secondary)]">
      <button
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-[var(--color-bg-tertiary)] transition-colors cursor-pointer"
      >
        <div className="flex-1 min-w-0">
          {/* Dimmed with the muted token, not opacity, which would take the muted line below 4.5:1. */}
          <div
            className={`text-sm font-medium ${hasMatches ? 'text-[var(--color-text-primary)]' : 'text-[var(--color-text-muted)]'}`}
          >
            {ocsfClass.caption}
            {fit.declared && (
              <span className="ml-2 align-middle">
                <Badge variant="info">class_uid in the data</Badge>
              </span>
            )}
          </div>
          <div className="text-xs text-[var(--color-text-muted)]">
            {ocsfClass.categoryCaption} · <span className="font-mono">class_uid {ocsfClass.uid}</span>
          </div>
        </div>
        <div className="w-32">
          <ProgressBar value={result.requiredPercent} variant={hasMatches ? variant : 'default'} label="Required" />
        </div>
        <div className="w-32">
          <ProgressBar value={result.totalPercent} variant="default" label="Total" />
        </div>
        <Icon
          name="chevron-down"
          className={`w-4 h-4 text-[var(--color-text-muted)] transition-transform ${expanded ? 'rotate-180' : ''}`}
        />
      </button>

      {expanded && (
        <div className="motion-reveal px-3 py-2 border-t border-[var(--color-border)] space-y-2">
          {result.constraints.map((c) => (
            <ConstraintLine key={c.kind + c.attributes.join()} constraint={c} />
          ))}
          <AttributeGroup title="Required attributes" requirement="required" fit={fit} />
          <AttributeGroup title="Recommended attributes" requirement="recommended" fit={fit} />
          <button
            type="button"
            aria-expanded={showOptional}
            onClick={() => setShowOptional(!showOptional)}
            className="text-xs text-[var(--color-accent)] hover:underline cursor-pointer"
          >
            Optional attributes ({optional.filter((a) => a.present).length} of {optional.length})
          </button>
          {showOptional && <AttributeGroup title="Optional attributes" requirement="optional" fit={fit} />}
        </div>
      )}
    </div>
  );
}

function ConstraintLine({ constraint }: { constraint: OcsfConstraintCoverage }) {
  const rule = constraint.kind === 'just_one' ? 'Exactly one of' : 'At least one of';
  return (
    <div className="text-xs" style={{ color: constraint.satisfied ? 'var(--color-success)' : 'var(--color-warning)' }}>
      {rule} <span className="font-mono">{constraint.attributes.join(', ')}</span>:{' '}
      {constraint.satisfied ? 'satisfied' : 'not satisfied'}
    </div>
  );
}

function AttributeGroup({
  title,
  requirement,
  fit,
}: {
  title: string;
  requirement: OcsfAttributeCoverage['requirement'];
  fit: OcsfFit;
}) {
  const attributes = fit.result.attributes.filter((a) => a.requirement === requirement);
  const missing = attributes.filter((a) => !a.present).map((a) => a.path);
  return (
    <div>
      <div className="text-xs font-medium text-[var(--color-text-muted)] mb-1">{title}</div>
      <AttributeChips attributes={attributes} missing={missing} ocsfClass={fit.result.ocsfClass} />
    </div>
  );
}

function AttributeChips({
  attributes,
  missing,
  ocsfClass,
}: {
  attributes: readonly OcsfAttributeCoverage[];
  missing: string[];
  ocsfClass: OcsfClass;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {attributes.map((a) =>
        a.children ? (
          <ObjectChip key={a.path} attribute={a} missing={missing} ocsfClass={ocsfClass} />
        ) : (
          <AttributeChip key={a.path} attribute={a} missing={missing} ocsfClass={ocsfClass} />
        ),
      )}
    </div>
  );
}

const PRESENT_CHIP = 'bg-[var(--color-success)]/10 text-[var(--color-success)]';
const MISSING_CHIP = 'bg-[var(--color-error)]/10 text-[var(--color-error)]';
// A missing optional attribute is not a fault, so it is not red.
const OPTIONAL_CHIP = 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)]';

function chipClass(attribute: OcsfAttributeCoverage): string {
  if (attribute.present) return PRESENT_CHIP;
  return attribute.requirement === 'optional' ? OPTIONAL_CHIP : MISSING_CHIP;
}

function Mark({ present }: { present: boolean }) {
  return (
    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d={present ? 'M5 13l4 4L19 7' : 'M6 18L18 6M6 6l12 12'} />
    </svg>
  );
}

/** The name of an attribute: its last part, because the object chip above a child names the rest. */
const leafName = (path: string) => path.slice(path.lastIndexOf('.') + 1);

interface ChipProps {
  attribute: OcsfAttributeCoverage;
  missing: string[];
  ocsfClass: OcsfClass;
}

function AttributeChip({ attribute, missing, ocsfClass }: ChipProps) {
  const chip = (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono ${chipClass(attribute)}`}
      title={attribute.path}
    >
      <Mark present={attribute.present} />
      {leafName(attribute.path)}
      {attribute.object && <span aria-hidden="true">{'{…}'}</span>}
    </span>
  );
  if (attribute.present) return chip;
  return (
    <ContextMenu>
      <ContextMenuTrigger>{chip}</ContextMenuTrigger>
      <ContextMenuContent>
        <MissingAttributeMenuItems attribute={attribute} missing={missing} ocsfClass={ocsfClass} />
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** An object attribute of the class: it opens to the attributes of its object, one level down. */
function ObjectChip({ attribute, missing, ocsfClass }: ChipProps) {
  const [open, setOpen] = useState(false);
  const childrenId = useId();
  const children = attribute.children ?? [];
  const childMissing = children.filter((c) => !c.present).map((c) => c.path);
  const button = (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={childrenId}
      onClick={() => setOpen(!open)}
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono cursor-pointer ${chipClass(attribute)}`}
    >
      <Mark present={attribute.present} />
      {/* The space keeps the path and the count apart in the accessible name. */}
      {attribute.path}{' '}
      <span className="font-sans">
        ({children.filter((c) => c.present).length}/{children.length})
      </span>
      <Icon name="chevron-down" className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} />
    </button>
  );
  return (
    <div className={open ? 'basis-full' : ''}>
      {attribute.present ? (
        button
      ) : (
        <ContextMenu>
          <ContextMenuTrigger>{button}</ContextMenuTrigger>
          <ContextMenuContent>
            <MissingAttributeMenuItems attribute={attribute} missing={missing} ocsfClass={ocsfClass} />
          </ContextMenuContent>
        </ContextMenu>
      )}
      {open && (
        <div id={childrenId} className="mt-1 ml-3 pl-2 border-l border-[var(--color-border)]">
          <div className="text-xs text-[var(--color-text-muted)] mb-1">
            <Identifier>{attribute.object}</Identifier> attributes
          </div>
          <AttributeChips attributes={children} missing={childMissing} ocsfClass={ocsfClass} />
        </div>
      )}
    </div>
  );
}

/** The value of an attribute that is a constant of the class, or undefined. */
function constantOf(path: string, ocsfClass: OcsfClass): number | undefined {
  if (path === 'class_uid') return ocsfClass.uid;
  if (path === 'category_uid') return Math.floor(ocsfClass.uid / 1000);
  return undefined;
}

/**
 * The menu of a missing attribute. An alias from a field that the events
 * have is the usual way to make it, as for a CIM field (#761). An object is
 * made by its attributes, so it has only the copy items: open it, and alias
 * an attribute of it.
 */
function MissingAttributeMenuItems({ attribute, missing, ocsfClass }: ChipProps) {
  const setFieldAlias = useAppStore((s) => s.setFieldAlias);
  const { apply } = useApplyDirective();
  const { path } = attribute;
  const constant = constantOf(path, ocsfClass);
  return (
    <>
      <ContextMenuLabel>
        <Identifier>{path}</Identifier>
      </ContextMenuLabel>
      {!attribute.object && (
        <ContextMenuItem onSelect={() => setFieldAlias({ alias: path })}>Create FIELDALIAS…</ContextMenuItem>
      )}
      {constant !== undefined && (
        <ContextMenuItem onSelect={() => apply(`EVAL-${path}`, String(constant))}>
          Add EVAL-{path} = {constant}
        </ContextMenuItem>
      )}
      <ContextMenuItem onSelect={() => copyQuietly(path)}>Copy field name</ContextMenuItem>
      <ContextMenuItem onSelect={() => copyQuietly(missing.join(', '))}>Copy the missing fields</ContextMenuItem>
    </>
  );
}
