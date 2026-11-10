import { fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setCsrfToken } from '../../api/client';
import { jsonResponse, renderRoutes, SESSION } from '../../test/render';
import { LoginPage, PublicOnly, RegisterPage, RequireAuth } from './AuthPages';

const routes = [
  {
    element: <PublicOnly />,
    children: [
      { path: '/login', element: <LoginPage /> },
      { path: '/register', element: <RegisterPage /> },
    ],
  },
  { element: <RequireAuth />, children: [{ path: '/', element: <p>Dashboard home</p> }] },
];

afterEach(() => {
  vi.unstubAllGlobals();
  setCsrfToken(null);
});

describe('authentication pages', () => {
  it('redirects signed-out visitors to the login page', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'Sign in' } }),
        ),
      ),
    );
    renderRoutes(routes, '/');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('signs in and lands on the dashboard', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/v1/auth/login') {
        expect(JSON.parse(String(init?.body))).toEqual({
          email: 'ada@example.test',
          password: 'a long passphrase',
        });
        return Promise.resolve(jsonResponse(200, SESSION));
      }
      return Promise.resolve(
        jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'Sign in' } }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    renderRoutes(routes, '/login');

    fireEvent.change(await screen.findByLabelText('Email'), {
      target: { value: 'ada@example.test' },
    });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'a long passphrase' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Dashboard home')).toBeInTheDocument();
  });

  it('shows the server’s error for bad credentials', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          jsonResponse(401, {
            error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' },
          }),
        ),
      ),
    );
    renderRoutes(routes, '/login');
    fireEvent.change(await screen.findByLabelText('Email'), {
      target: { value: 'ada@example.test' },
    });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password');
  });

  it('blocks registration when passwords do not match', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(jsonResponse(401, { error: { code: 'UNAUTHENTICATED', message: 'x' } })),
      ),
    );
    renderRoutes(routes, '/register');
    fireEvent.change(await screen.findByLabelText('Password'), {
      target: { value: 'a long passphrase' },
    });
    fireEvent.change(screen.getByLabelText('Confirm password'), {
      target: { value: 'something else!!' },
    });
    expect(screen.getByText('Passwords do not match')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create account' })).toBeDisabled();
  });
});
