import { useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect } from 'react';
import { meKey, useMe } from '../../api/auth';
import { UNAUTHORIZED_EVENT } from '../../api/client';
import { applyTheme } from '../../lib/theme';
import { Logo } from '../Logo';
import { LoginPage } from './LoginPage';

/** Shows the login screen until there is a session; the signed-in user's theme is applied here. */
export function AuthGate({ children }: { children: ReactNode }) {
  const me = useMe();
  const queryClient = useQueryClient();

  useEffect(() => {
    const signedOut = () => queryClient.setQueryData(meKey, null);
    window.addEventListener(UNAUTHORIZED_EVENT, signedOut);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, signedOut);
  }, [queryClient]);

  useEffect(() => {
    if (me.data) applyTheme(me.data.theme);
  }, [me.data]);

  if (me.isPending) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="animate-pulse">
          <Logo size={48} />
        </div>
      </div>
    );
  }
  if (!me.data) return <LoginPage error={me.error} />;
  return <>{children}</>;
}
