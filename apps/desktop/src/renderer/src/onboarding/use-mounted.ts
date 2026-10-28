import { useEffect, useRef } from 'react';

/**
 * Whether the component is still on screen, for a step whose IPC call may answer after the User
 * has skipped or gone back: a late answer must neither update the step nor move the wizard.
 */
export function useMounted(): { readonly current: boolean } {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}
