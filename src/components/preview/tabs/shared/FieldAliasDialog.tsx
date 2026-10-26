import { useEffect, useId, useRef, useState } from 'react';
import { useAppStore, type FieldAliasRequest } from '../../../../store/useAppStore';
import { DirectiveDialog, DirectiveForm } from './DirectiveDialog';
import { AddedLine } from './ExtractNameDialog';
import { useApplyDirective } from './useApplyDirective';
import { fieldAliasDirective } from './fieldDirective';

/**
 * "Create FIELDALIAS…" from a field's context menu (#745), or from a missing
 * CIM field (#761). One dialog for the app, opened through the store: every
 * field row has a menu, and a dialog per row would put thousands of them in a
 * wide table.
 */
export function FieldAliasDialog() {
  const request = useAppStore((s) => s.fieldAlias);
  const setFieldAlias = useAppStore((s) => s.setFieldAlias);
  // The last request, kept through the exit animation after the store clears it.
  const [shown, setShown] = useState(request);
  if (request !== null && request !== shown) setShown(request);
  const close = () => setFieldAlias(null);

  return (
    <DirectiveDialog open={request !== null} title="Create FIELDALIAS" onClose={close}>
      {shown !== null && <FieldAliasForm request={shown} onClose={close} />}
    </DirectiveDialog>
  );
}

/** A name with no whitespace, quotes or `=`, which would end the directive's value early. */
const isFieldName = (name: string) => /^[^\s'"=]+$/.test(name);

/** The field names of the last run, offered as the source of an alias. */
function useRunFieldNames(): string[] {
  const stats = useAppStore((s) => s.processingResult?.fieldStats);
  return stats ? [...new Set([...stats.names, ...stats.metadataNames])].sort() : [];
}

/** The fixed half of the request is shown; the other half is typed. */
function FieldAliasForm({ request, onClose }: { request: FieldAliasRequest; onClose: () => void }) {
  const { stanzaFor, apply } = useApplyDirective();
  const [typed, setTyped] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const fieldNames = useRunFieldNames();

  useEffect(() => {
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, []);

  const name = typed.trim();
  const fixed = 'source' in request ? request.source : request.alias;
  const [source, alias] = 'source' in request ? [request.source, name] : [name, request.alias];
  const valid = isFieldName(name) && name !== fixed;
  const { key, value } = fieldAliasDirective(source, alias);

  return (
    <DirectiveForm
      applyLabel="Add FIELDALIAS"
      applyDisabled={!valid}
      onApply={() => {
        if (!valid) return;
        apply(key, value);
        onClose();
      }}
      onClose={onClose}
    >
      <div>
        <label
          htmlFor="field-alias-name"
          className="text-xs font-semibold uppercase tracking-wider"
          style={{ color: 'var(--color-text-secondary)' }}
        >
          {'source' in request ? 'Alias for ' : 'Field to alias as '}
          <code className="font-mono normal-case">{fixed}</code>
        </label>
        <input
          id="field-alias-name"
          ref={inputRef}
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={'source' in request ? 'for example src_ip' : 'a field the events have'}
          spellCheck={false}
          {...('alias' in request && fieldNames.length > 0 ? { list: listId } : {})}
          className="mt-1 w-full px-2.5 py-1.5 rounded-md text-sm font-mono outline-none bg-[var(--color-bg-secondary)] text-[var(--color-text-primary)] border border-[var(--color-border-control)] focus:border-[var(--color-accent)]"
        />
        {'alias' in request && (
          <datalist id={listId}>
            {fieldNames.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
        )}
        {name !== '' && !valid && (
          <div className="mt-1 text-xs" style={{ color: 'var(--color-warning)' }}>
            {name === fixed
              ? 'The alias and the field need different names.'
              : 'A name cannot hold spaces, quotes or =.'}
          </div>
        )}
      </div>
      <AddedLine stanza={stanzaFor(key)} line={valid ? `${key} = ${value}` : 'Enter a field name…'} />
    </DirectiveForm>
  );
}
