import { fireEvent, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '../../test/render';
import { RevealKeyDialog } from './AgentDetailPage';

const CREATED = {
  secret: `lsh_${'A'.repeat(43)}`,
  apiKey: {
    id: '0196a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
    label: null,
    prefix: 'lsh_AAAAAAAA',
    status: 'ACTIVE' as const,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastUsedAt: null,
    expiresAt: '2026-02-01T00:00:00.000Z',
    revokedAt: null,
  },
};

function Harness() {
  const [created, setCreated] = useState<typeof CREATED | null>(CREATED);
  return <RevealKeyDialog created={created} onDone={() => setCreated(null)} />;
}

describe('RevealKeyDialog', () => {
  it('shows the key once, warns it will not be shown again, and forgets it on close', () => {
    renderWithProviders(<Harness />);
    expect(screen.getByTestId('new-api-key')).toHaveTextContent(CREATED.secret);
    expect(screen.getByText(/only time the key will be shown/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /stored it safely/ }));
    expect(screen.queryByTestId('new-api-key')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(CREATED.secret);
  });
});
