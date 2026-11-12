// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// EventPagination.test.tsx
// The event pager (#881): first, last and a page box next to Prev and Next,
// a polite announcement of the page the user moved to, and 24 px targets.
// ---------------------------------------------------------------------------

import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { EventPagination } from '../EventPagination';
import { parsePageInput } from '../../../utils/pagination';

/** The pager over 500 events at 10 a page, with its page held as the app holds it. */
function Pager({ start = 1, onPageChange }: { start?: number; onPageChange?: (page: number) => void }) {
  const [page, setPage] = useState(start);
  return (
    <EventPagination
      currentPage={page}
      totalPages={50}
      totalItems={500}
      eventsPerPage={10}
      onPageChange={(p) => {
        onPageChange?.(p);
        setPage(p);
      }}
      onEventsPerPageChange={() => {}}
    />
  );
}

const button = (name: string) => screen.getByRole('button', { name });
const pageBox = () => screen.getByRole('textbox', { name: 'Page' });
const status = () => screen.getByRole('status');

describe('EventPagination', () => {
  it('goes to the last page and back to the first', () => {
    render(<Pager />);
    expect(button('First page')).toBeDisabled();
    expect(button('Previous page')).toBeDisabled();

    fireEvent.click(button('Last page'));
    expect(pageBox()).toHaveValue('50');
    expect(screen.getByText('Showing events 491-500 of 500')).toBeInTheDocument();
    expect(button('Last page')).toBeDisabled();
    expect(button('Next page')).toBeDisabled();

    fireEvent.click(button('First page'));
    expect(pageBox()).toHaveValue('1');
    expect(button('Last page')).toBeEnabled();
  });

  it('moves one page with Previous and Next', () => {
    render(<Pager start={7} />);
    fireEvent.click(button('Next page'));
    expect(pageBox()).toHaveValue('8');
    fireEvent.click(button('Previous page'));
    fireEvent.click(button('Previous page'));
    expect(pageBox()).toHaveValue('6');
  });

  it('goes to the page typed in the box on Enter, and keeps the focus there', () => {
    render(<Pager />);
    pageBox().focus();
    fireEvent.change(pageBox(), { target: { value: '23' } });
    fireEvent.keyDown(pageBox(), { key: 'Enter' });
    expect(pageBox()).toHaveValue('23');
    expect(screen.getByText('Showing events 221-230 of 500')).toBeInTheDocument();
    expect(pageBox()).toHaveFocus();
    expect(pageBox()).toHaveAccessibleDescription('of 50');
  });

  it('goes to the page typed in the box when the box loses the focus', () => {
    const onPageChange = vi.fn();
    render(<Pager onPageChange={onPageChange} />);
    fireEvent.change(pageBox(), { target: { value: '4' } });
    fireEvent.blur(pageBox());
    expect(onPageChange).toHaveBeenCalledWith(4);
  });

  it('clamps a number past the pages, and puts back text that is not a number', () => {
    const onPageChange = vi.fn();
    render(<Pager start={3} onPageChange={onPageChange} />);
    fireEvent.change(pageBox(), { target: { value: '999' } });
    fireEvent.keyDown(pageBox(), { key: 'Enter' });
    expect(pageBox()).toHaveValue('50');

    fireEvent.change(pageBox(), { target: { value: 'abc' } });
    fireEvent.keyDown(pageBox(), { key: 'Enter' });
    expect(pageBox()).toHaveValue('50');
    expect(onPageChange).toHaveBeenCalledTimes(1);
  });

  it('puts the current page back on Escape, and does not move', () => {
    const onPageChange = vi.fn();
    render(<Pager start={5} onPageChange={onPageChange} />);
    fireEvent.change(pageBox(), { target: { value: '12' } });
    fireEvent.keyDown(pageBox(), { key: 'Escape' });
    expect(pageBox()).toHaveValue('5');
    fireEvent.blur(pageBox());
    expect(onPageChange).not.toHaveBeenCalled();
  });

  it('does not call back for the page it is on', () => {
    const onPageChange = vi.fn();
    render(<Pager start={5} onPageChange={onPageChange} />);
    fireEvent.change(pageBox(), { target: { value: '5' } });
    fireEvent.keyDown(pageBox(), { key: 'Enter' });
    expect(onPageChange).not.toHaveBeenCalled();
  });

  it('announces a page the user moved to, politely, and nothing before', () => {
    render(<Pager />);
    expect(status()).toHaveAttribute('aria-live', 'polite');
    expect(status()).toHaveTextContent(/^$/);
    fireEvent.click(button('Next page'));
    expect(status()).toHaveTextContent('Page 2 of 50, events 11 to 20');
    fireEvent.click(button('Last page'));
    expect(status()).toHaveTextContent('Page 50 of 50, events 491 to 500');
  });

  it('does not announce a page count that changes under it', () => {
    const props = {
      currentPage: 1,
      totalItems: 30,
      eventsPerPage: 10,
      onPageChange: () => {},
      onEventsPerPageChange: () => {},
    };
    const { rerender } = render(<EventPagination {...props} totalPages={3} />);
    rerender(<EventPagination {...props} totalPages={2} totalItems={20} />);
    expect(status()).toHaveTextContent(/^$/);
  });

  it('names what the events have in common', () => {
    render(
      <EventPagination
        currentPage={2}
        totalPages={7}
        totalItems={340}
        eventsPerPage={50}
        onPageChange={() => {}}
        onEventsPerPageChange={() => {}}
        scope="with src_ip"
      />,
    );
    expect(screen.getByText('Showing events 51-100 of 340 with src_ip')).toBeInTheDocument();
  });

  it('turns off the page box when there is one page', () => {
    render(
      <EventPagination
        currentPage={1}
        totalPages={1}
        totalItems={8}
        eventsPerPage={10}
        onPageChange={() => {}}
        onEventsPerPageChange={() => {}}
      />,
    );
    expect(pageBox()).toBeDisabled();
  });

  // WCAG 2.2 2.5.8: jsdom has no layout, so the floor is read off the classes.
  it('gives each control a target of at least 24 px', () => {
    render(<Pager />);
    for (const control of [...screen.getAllByRole('button'), pageBox(), screen.getByRole('combobox')]) {
      expect(control.className).toMatch(/\bmin-h-6\b/);
    }
    for (const control of screen.getAllByRole('button')) expect(control.className).toMatch(/\bmin-w-6\b/);
  });
});

describe('parsePageInput', () => {
  it.each([
    ['7', 7],
    [' 7 ', 7],
    ['0', 1],
    ['-3', 1],
    ['51', 50],
    ['12abc', 12],
    ['', null],
    ['x', null],
  ])('reads %j as %j of 50 pages', (text, page) => {
    expect(parsePageInput(text, 50)).toBe(page);
  });
});
