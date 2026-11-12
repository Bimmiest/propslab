// @vitest-environment jsdom
// Names with one prefix stay different when cut (#893): the end of the name is
// the part that cannot shrink.
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { KEPT_TAIL, MiddleTruncate } from '../MiddleTruncate';

describe('MiddleTruncate', () => {
  it('cuts a short text at the end, as one part', () => {
    const { container } = render(<MiddleTruncate text="dest_ip" />);
    const span = container.firstElementChild;
    expect(span).toHaveTextContent('dest_ip');
    expect(span).toHaveClass('truncate');
    expect(span?.children).toHaveLength(0);
  });

  it('keeps the last characters of a long text whole, and the start can shrink', () => {
    const { container } = render(<MiddleTruncate text="bytes_received" />);
    const [start, tail] = container.querySelectorAll('[aria-hidden="true"]');
    expect(start).toHaveTextContent('bytes_re');
    expect(start).toHaveClass('truncate');
    expect(tail).toHaveTextContent('ceived');
    expect(tail).toHaveClass('shrink-0');
    expect(tail?.textContent).toHaveLength(KEPT_TAIL);
  });

  it('gives the different ends of names with one prefix', () => {
    const tails = ['bytes_received', 'bytes_sent', 'bytes_total'].map((text) => {
      const { container } = render(<MiddleTruncate text={text} />);
      return container.querySelector('.shrink-0')?.textContent;
    });
    expect(new Set(tails).size).toBe(3);
  });

  it('reads the whole text once to assistive technology', () => {
    const { container } = render(<MiddleTruncate text="bytes_received" />);
    const read = container.querySelectorAll('.sr-only');
    expect(read).toHaveLength(1);
    expect(read[0]).toHaveTextContent('bytes_received');
    expect(read[0]).not.toHaveAttribute('aria-hidden');
  });

  it('keeps the class it is given', () => {
    const { container } = render(<MiddleTruncate text="bytes_received" className="text-xs" />);
    expect(container.firstElementChild).toHaveClass('text-xs', 'min-w-0');
  });
});
