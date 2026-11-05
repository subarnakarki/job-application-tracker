import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { moveErrorMessage, StatusMenu } from './StatusMenu';

describe('StatusMenu', () => {
  it('moves to the chosen stage, and is named after the application', async () => {
    const onMove = vi.fn();
    render(<StatusMenu company="Acme" status="Applied" onMove={onMove} />);
    const menu = screen.getByRole('combobox', { name: 'Move Acme to' });
    expect(menu).toHaveValue('Applied');
    await userEvent.selectOptions(menu, 'Interviewing');
    expect(onMove).toHaveBeenCalledWith('Interviewing');
  });

  it('explains a conflict differently from other failures', () => {
    expect(moveErrorMessage('Acme', { status: 412 })).toMatch(/changed somewhere else/);
    expect(moveErrorMessage('Acme', new Error('offline'))).toBe('Could not move Acme. Try again.');
  });
});
