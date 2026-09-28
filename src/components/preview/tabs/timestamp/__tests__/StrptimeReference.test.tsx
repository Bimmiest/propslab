// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { StrptimeReference } from '../StrptimeReference';

describe('StrptimeReference', () => {
  it('says in text which rows the preview does not simulate', () => {
    render(<StrptimeReference activeDirectives={[]} />);
    fireEvent.click(screen.getByRole('button', { name: 'STRPTIME Reference' }));
    const rowOf = (spec: string) => screen.getByText(spec, { selector: 'code' }).closest('tr')!;
    expect(within(rowOf('%c')).getByText('not simulated')).toHaveAttribute('title', expect.stringContaining('%c is not simulated'));
    expect(within(rowOf('%Y')).queryByText('not simulated')).not.toBeInTheDocument();
    expect(screen.getAllByText('not simulated')).toHaveLength(18);
  });
});
