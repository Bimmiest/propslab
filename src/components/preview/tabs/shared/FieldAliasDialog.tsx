import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../../../store/useAppStore';
import { DirectiveDialog, DirectiveForm } from './DirectiveDialog';
import { AddedLine } from './ExtractNameDialog';
import { useApplyDirective } from './useApplyDirective';
import { fieldAliasDirective } from './fieldDirective';

/**
 * "Create FIELDALIAS…" from a field's context menu (#745). One dialog for the
 * app, opened through the store: every field row has a menu, and a dialog
 * per row would put thousands of them in a wide table.
 */
export function FieldAliasDialog() {
  const field = useAppStore((s) => s.fieldAliasFor);
  const setFieldAliasFor = useAppStore((s) => s.setFieldAliasFor);
  // The last field, kept through the exit animation after the store clears it.
  const [shown, setShown] = useState(field);
  if (field !== null && field !== shown) setShown(field);
  const close = () => setFieldAliasFor(null);

  return (
    <DirectiveDialog open={field !== null} title="Create FIELDALIAS" onClose={close}>
      {shown !== null && <FieldAliasForm field={shown} onClose={close} />}
    </DirectiveDialog>
  );
}

/** A name with no whitespace, quotes or `=`, which would end the directive's value early. */
const isAliasName = (name: string) => /^[^\s'"=]+$/.test(name);

function FieldAliasForm({ field, onClose }: { field: string; onClose: () => void }) {
  const { stanzaFor, apply } = useApplyDirective();
  const [alias, setAlias] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, []);

  const name = alias.trim();
  const valid = isAliasName(name) && name !== field;
  const { key, value } = fieldAliasDirective(field, name);

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
          Alias for <code className="font-mono normal-case">{field}</code>
        </label>
        <input
          id="field-alias-name"
          ref={inputRef}
          type="text"
          value={alias}
          onChange={(e) => setAlias(e.target.value)}
          placeholder="for example src_ip"
          spellCheck={false}
          className="mt-1 w-full px-2.5 py-1.5 rounded-md text-sm font-mono outline-none bg-[var(--color-bg-secondary)] text-[var(--color-text-primary)] border border-[var(--color-border-control)] focus:border-[var(--color-accent)]"
        />
        {name !== '' && !valid && (
          <div className="mt-1 text-xs" style={{ color: 'var(--color-warning)' }}>
            {name === field
              ? 'An alias needs a name other than the field’s.'
              : 'A name cannot hold spaces, quotes or =.'}
          </div>
        )}
      </div>
      <AddedLine stanza={stanzaFor(key)} line={valid ? `${key} = ${value}` : 'Enter an alias name…'} />
    </DirectiveForm>
  );
}
