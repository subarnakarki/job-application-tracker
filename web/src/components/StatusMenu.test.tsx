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

  it('drops the stage bars when compact, keeping the same menu', async () => {
    const onMove = vi.fn();
    const { rerender } = render(<StatusMenu company="Acme" status="Applied" onMove={onMove} />);
    expect(screen.getByTestId('stage-bars')).toBeInTheDocument();

    rerender(<StatusMenu company="Acme" status="Applied" onMove={onMove} compact />);
    expect(screen.queryByTestId('stage-bars')).not.toBeInTheDocument();
    const menu = screen.getByRole('combobox', { name: 'Move Acme to' });
    await userEvent.selectOptions(menu, 'Withdrawn');
    expect(onMove).toHaveBeenCalledWith('Withdrawn');
  });

  it('explains a conflict differently from other failures', () => {
    expect(moveErrorMessage('Acme', { status: 412 })).toMatch(/changed somewhere else/);
    expect(moveErrorMessage('Acme', new Error('offline'))).toBe('Could not move Acme. Try again.');
  });
});
