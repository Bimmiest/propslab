import type React from 'react';
import { useAppStore } from '../../store/useAppStore';
import { getStagesForDirective, PHASE_LABELS } from '../../engine/pipelineStages';
import { CopyButton } from '../editor/CopyButton';
import { Icon } from '../ui/Icon';
import { Chip, DirectiveBadges } from './DictionaryBadges';
import type { DictionaryEntry } from './entries';

type DirectiveEntryInfo = Extract<DictionaryEntry, { kind: 'directive' }>['info'];
type StanzaEntryInfo = Extract<DictionaryEntry, { kind: 'stanza' }>['stanza'];

/**
 * Page frame. Capped and centred so prose does not run to a 2000px measure on a
 * wide monitor, and so the two columns below keep a stable relationship to each
 * other instead of drifting apart as the window grows.
 */
function Page({ children }: { children: React.ReactNode }) {
  return <article className="mx-auto w-full max-w-5xl px-6 py-6 sm:px-8 sm:py-7">{children}</article>;
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">
      {children}
    </p>
  );
}

/**
 * Header block: category, key, badges, then a rule that separates the identity
 * of the thing from everything said about it.
 */
function PageHeader({
  eyebrow,
  title,
  badges,
}: {
  eyebrow: string;
  title: string;
  badges: React.ReactNode;
}) {
  return (
    <header className="flex flex-col gap-2 pb-5 mb-6 border-b" style={{ borderColor: 'var(--color-border-subtle)' }}>
      <Eyebrow>{eyebrow}</Eyebrow>
      <h2 className="text-xl sm:text-2xl font-semibold font-mono tracking-tight text-[var(--color-text-primary)]">
        {title}
      </h2>
      <div className="flex flex-wrap items-center gap-1.5 pt-0.5">{badges}</div>
    </header>
  );
}

/**
 * The two-column body: prose and examples on the left, reference data on the
 * right. Stacks below `lg`, where a 280px aside would squeeze the code blocks.
 */
function Columns({ main, aside }: { main: React.ReactNode; aside: React.ReactNode }) {
  return (
    <div className="grid gap-6 lg:gap-8 lg:grid-cols-[minmax(0,1fr)_260px] items-start">
      <div className="flex flex-col gap-6 min-w-0">{main}</div>
      <div className="flex flex-col gap-4 lg:sticky lg:top-6">{aside}</div>
    </div>
  );
}

function Lede({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[13px] leading-[1.7] text-[var(--color-text-secondary)] max-w-prose">
      {children}
    </p>
  );
}

/** Boxed group used for both the code sample and the reference tables. */
function Card({
  label,
  action,
  children,
  flush = false,
}: {
  label: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  flush?: boolean;
}) {
  return (
    <section
      className="rounded-lg border overflow-hidden"
      style={{ borderColor: 'var(--color-border-subtle)', backgroundColor: 'var(--color-bg-elevated)' }}
    >
      <div
        className="flex items-center justify-between gap-2 px-3 h-8 border-b"
        style={{ borderColor: 'var(--color-border-subtle)', backgroundColor: 'var(--color-bg-secondary)' }}
      >
        <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">
          {label}
        </span>
        {action}
      </div>
      <div className={flush ? '' : 'px-3 py-2.5'}>{children}</div>
    </section>
  );
}

function CodeCard({ label, code }: { label: string; code: string }) {
  return (
    <Card label={label} action={<CopyButton getText={() => code} />} flush>
      <pre className="px-3 py-2.5 text-[12px] leading-relaxed font-mono overflow-x-auto text-[var(--color-text-primary)]">
        {code}
      </pre>
    </Card>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-[11px] break-words">{children}</span>;
}

/** Label/value rows inside an aside card. Ruled rather than boxed, to stay quiet. */
function SpecRows({ rows }: { rows: { label: string; value: React.ReactNode }[] }) {
  return (
    <dl className="flex flex-col">
      {rows.map((row, i) => (
        <div
          key={row.label}
          className="flex items-baseline justify-between gap-3 py-1.5"
          style={i > 0 ? { borderTop: '1px solid var(--color-border-subtle)' } : undefined}
        >
          <dt className="shrink-0 text-[11px] text-[var(--color-text-muted)]">{row.label}</dt>
          <dd className="min-w-0 text-right text-[var(--color-text-primary)]">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Callout({
  tone,
  icon,
  children,
}: {
  tone: 'danger' | 'info';
  icon: React.ComponentProps<typeof Icon>['name'];
  children: React.ReactNode;
}) {
  const color = tone === 'danger' ? 'var(--color-error)' : 'var(--color-text-secondary)';
  return (
    <p
      className="flex items-start gap-2 rounded-md px-3 py-2.5 text-[12px] leading-relaxed max-w-prose"
      style={{
        color,
        backgroundColor: tone === 'danger' ? 'rgba(239, 68, 68, 0.10)' : 'var(--color-bg-secondary)',
        border: `1px solid ${tone === 'danger' ? 'rgba(239, 68, 68, 0.25)' : 'var(--color-border-subtle)'}`,
      }}
    >
      <Icon name={icon} className="w-3.5 h-3.5 shrink-0 mt-0.5" />
      <span>{children}</span>
    </p>
  );
}

export function DictionaryDetail({ entry }: { entry: DictionaryEntry }) {
  const toggleHelp = useAppStore((s) => s.toggleHelp);
  const helpOpen = useAppStore((s) => s.helpOpen);

  const openPipelineReference = () => {
    if (!helpOpen) toggleHelp();
  };

  if (entry.kind === 'stanza') return <StanzaDetail stanza={entry.stanza} />;

  const { info } = entry;
  const stages = getStagesForDirective(info.key);

  return (
    <Page>
      <PageHeader
        eyebrow={info.category}
        title={info.isClassBased ? `${info.key}-<class>` : info.key}
        badges={<DirectiveBadges info={info} />}
      />

      <Columns
        main={
          <>
            <SupportCallouts info={info} />

            <Lede>{info.description}</Lede>

            <CodeCard label={info.appliesTo === 'both' ? 'Example' : info.appliesTo} code={info.example} />

            {info.isClassBased && (
              <Callout tone="info" icon="info">
                This key takes a class name suffix, so one stanza can declare several of them — for
                example <Mono>{info.key}-client_ip</Mono> and <Mono>{info.key}-status</Mono>. The suffix
                names the setting; it is not part of the extracted field name.
              </Callout>
            )}
          </>
        }
        aside={
          <>
            <Card label="Specification">
              <SpecRows
                rows={[
                  { label: 'Default', value: <Mono>{info.defaultValue || '(none)'}</Mono> },
                  { label: 'Type', value: <Mono>{info.valueType}</Mono> },
                  { label: 'File', value: <Mono>{info.appliesTo}</Mono> },
                  { label: 'Category', value: <span className="text-[11px]">{info.category}</span> },
                ]}
              />
            </Card>

            {info.enumValues && info.enumValues.length > 0 && (
              <Card label="Valid values">
                <div className="flex flex-wrap gap-1">
                  {info.enumValues.map((v) => (
                    <Chip key={v} mono>
                      {v}
                    </Chip>
                  ))}
                </div>
              </Card>
            )}

            {stages.length > 0 && (
              <StageLinks stages={stages} onOpen={openPipelineReference} />
            )}
          </>
        }
      />
    </Page>
  );
}

function StageLinks({ stages, onOpen }: { stages: ReturnType<typeof getStagesForDirective>; onOpen: () => void }) {
  return (
    <Card label="Runs at">
      <div className="flex flex-col gap-1.5">
        {stages.map((stage) => (
          <button
            key={stage.step}
            type="button"
            onClick={onOpen}
            title="Open the pipeline reference at this stage"
            className="group flex items-center gap-2 rounded-md px-2 py-1.5 -mx-1 text-left cursor-pointer
              border-none bg-transparent transition-colors hover:bg-[var(--color-bg-tertiary)]
              outline-none focus-visible:ring-2"
          >
            <span
              className="shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold"
              style={{
                backgroundColor: `color-mix(in srgb, ${
                  stage.phase === 'index-time'
                    ? 'var(--color-warning)'
                    : 'var(--color-accent)'
                } 18%, transparent)`,
                color:
                  stage.phase === 'index-time'
                    ? 'var(--color-warning)'
                    : 'var(--color-accent)',
              }}
            >
              {stage.step}
            </span>
            <span className="flex-1 min-w-0 flex flex-col">
              <span className="text-[12px] font-medium text-[var(--color-text-primary)] truncate">
                {stage.name}
              </span>
              <span className="text-[10px] text-[var(--color-text-muted)]">
                {PHASE_LABELS[stage.phase]}
              </span>
            </span>
            <Icon
              name="arrow-right"
              className="shrink-0 w-3.5 h-3.5 text-[var(--color-text-muted)] opacity-0 group-hover:opacity-100 transition-opacity"
            />
          </button>
        ))}
      </div>
    </Card>
  );
}

function SupportCallouts({ info }: { info: DirectiveEntryInfo }) {
  return (
    <>
      {info.deprecated && (
        <Callout tone="danger" icon="warning">
          This directive is deprecated and may be removed in a future Splunk release.
        </Callout>
      )}

      {/* Above the description, because it changes how the description
          should be read: everything below is what Splunk does, and this
          says whether the preview will do it too (#153). */}
      {info.support === 'ignored' && (
        <Callout tone="danger" icon="warning">
          <strong>Not simulated.</strong> {info.supportNote} The preview ignores this
          directive, so its output is what Splunk would produce without it
          {info.supportIssue ? ` (tracked as #${info.supportIssue})` : ''}.
        </Callout>
      )}

      {info.support === 'documented' && (
        <Callout tone="info" icon="info">
          <strong>Outside the simulation.</strong> {info.supportNote} It is documented here
          because it is valid Splunk config, but nothing in the preview depends on it.
        </Callout>
      )}

      {info.support === 'simulated' && info.supportNote && (
        <Callout tone="info" icon="info">
          <strong>Partly simulated.</strong> {info.supportNote}
        </Callout>
      )}
    </>
  );
}

function StanzaDetail({ stanza }: { stanza: StanzaEntryInfo }) {
  return (
    <Page>
      <PageHeader
        eyebrow="Stanza header"
        title={stanza.label}
        badges={
          <>
            <Chip>stanza header</Chip>
            <Chip mono>props.conf</Chip>
          </>
        }
      />
      <Columns
        main={
          <>
            <Lede>{stanza.description}</Lede>
            {/* `[default]` takes no pattern, so its example is the heading
                again. A code card that restates the title is ceremony. */}
            {stanza.example !== stanza.label && (
              <CodeCard label="Example" code={stanza.example} />
            )}
            {stanza.patternSyntax.length > 0 && (
              <Card label="Pattern syntax">
                <ul className="flex flex-col gap-1.5">
                  {stanza.patternSyntax.map((line) => (
                    <li key={line} className="flex gap-2 text-[12px] text-[var(--color-text-secondary)]">
                      <span aria-hidden="true" className="text-[var(--color-text-muted)]">
                        •
                      </span>
                      {/* The registry writes these with backtick spans; render
                          the literal text rather than pulling in a Markdown
                          parser for three bullet points. */}
                      <span>{line.replace(/`/g, '')}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </>
        }
        aside={
          <Card label="Precedence">
            <p className="text-[12px] leading-relaxed text-[var(--color-text-secondary)]">
              {stanza.precedence}
            </p>
          </Card>
        }
      />
    </Page>
  );
}

