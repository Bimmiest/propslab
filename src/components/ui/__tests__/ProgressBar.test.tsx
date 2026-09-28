// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProgressBar } from '../ProgressBar';

describe('ProgressBar', () => {
  it('gives the indeterminate progressbar an accessible name', () => {
    render(<ProgressBar label="Processing" />);
    expect(screen.getByRole('progressbar', { name: 'Processing' })).toBeInTheDocument();
  });

  it('falls back to a generic name when no label is given', () => {
    render(<ProgressBar />);
    expect(screen.getByRole('progressbar', { name: 'Loading' })).toBeInTheDocument();
  });
});
