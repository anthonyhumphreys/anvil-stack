import { createContext, useContext, useState, type ReactNode } from 'react';
import { createHashRouter, RouterProvider } from 'react-router-dom';

const RouteContent = createContext<ReactNode>(null);

function RouterContent() {
  return useContext(RouteContent);
}

/** A data router keeps hash URLs and supports blocking every navigation, including Back. */
export function AppRouter({ children }: { children: ReactNode }) {
  const [router] = useState(() => createHashRouter([{ path: '*', element: <RouterContent /> }]));
  return (
    <RouteContent.Provider value={children}>
      <RouterProvider router={router} />
    </RouteContent.Provider>
  );
}
