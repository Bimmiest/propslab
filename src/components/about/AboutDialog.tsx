// ---------------------------------------------------------------------------
// AboutDialog.tsx
// The build this page runs and where the project lives (#739), opened from
// the version in the status bar or from the command palette. A bug report
// needs the build, and a tooltip can neither be found easily nor copied.
// ---------------------------------------------------------------------------

import { useAppStore } from '../../store/useAppStore';
import { CopyButton } from '../editor/CopyButton';
import { DialogButton, DialogFooter, DialogFrame, DialogHeader } from '../ui/DialogFrame';
import { Icon } from '../ui/Icon';
import { BUILD_LABEL, COMMIT_DATE, COMMIT_URL, REPOSITORY_URL } from './buildInfo';

const LINKS = [
  { label: 'Source code', href: REPOSITORY_URL },
  { label: 'Changelog', href: `${REPOSITORY_URL}/blob/main/CHANGELOG.md` },
  { label: 'Report an issue', href: `${REPOSITORY_URL}/issues/new/choose` },
  { label: 'Security policy', href: `${REPOSITORY_URL}/blob/main/SECURITY.md` },
  { label: 'Licence (MIT)', href: `${REPOSITORY_URL}/blob/main/LICENSE` },
];

// Module-level, so CopyButton's memoised handler keeps one identity.
const getBuildLabel = () => BUILD_LABEL;

const LINK_CLASS = 'text-[var(--color-accent)] hover:underline';

export function AboutDialog() {
  const open = useAppStore((s) => s.aboutOpen);
  const toggleAbout = useAppStore((s) => s.toggleAbout);
  const close = () => {
    if (useAppStore.getState().aboutOpen) toggleAbout();
  };

  return (
    <DialogFrame
      open={open}
      onClose={close}
      label="About Propslab"
      header={
        <DialogHeader
          icon="info-circle"
          iconClassName="text-[var(--color-accent)]"
          title="About Propslab"
          titleHidden
        />
      }
      footer={
        <DialogFooter>
          {/* Radix skips links for the first focus and would land on Copy,
              whose tooltip then opens over the dialog on every open. */}
          <DialogButton variant="accent" onClick={close} autoFocus>
            Close
          </DialogButton>
        </DialogFooter>
      }
    >
      <div className="p-4 space-y-4 text-sm text-[var(--color-text-primary)]">
        <p className="text-[var(--color-text-secondary)]">
          A browser simulator of the Splunk props.conf and transforms.conf pipeline.
        </p>

        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
          <dt className="text-[var(--color-text-muted)]">Version</dt>
          <dd className="font-mono">{__APP_VERSION__}</dd>
          <dt className="text-[var(--color-text-muted)]">Commit</dt>
          <dd className="font-mono text-xs self-center break-all">
            {COMMIT_URL ? (
              <a href={COMMIT_URL} target="_blank" rel="noreferrer" className={LINK_CLASS}>
                {__APP_COMMIT__}
              </a>
            ) : (
              __APP_COMMIT__
            )}
          </dd>
          <dt className="text-[var(--color-text-muted)]">Committed</dt>
          <dd>
            {COMMIT_DATE ? (
              <time dateTime={COMMIT_DATE.toISOString()}>
                {COMMIT_DATE.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
              </time>
            ) : (
              'unknown'
            )}
          </dd>
        </dl>

        <div className="flex items-center gap-2 rounded-md px-2.5 py-1.5 bg-[var(--color-bg-secondary)]">
          <span className="text-xs shrink-0 text-[var(--color-text-muted)]">For a bug report</span>
          <code className="flex-1 min-w-0 truncate font-mono text-xs">{BUILD_LABEL}</code>
          <CopyButton getText={getBuildLabel} />
        </div>

        <ul className="space-y-1">
          {LINKS.map(({ label, href }) => (
            <li key={label}>
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className={`inline-flex items-center gap-1.5 ${LINK_CLASS}`}
              >
                <Icon name="arrow-right" className="w-3.5 h-3.5" />
                {label}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </DialogFrame>
  );
}
