import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type AnchorHTMLAttributes,
  type ReactNode,
} from "react";

interface RouterCtx {
  path: string;
  navigate: (to: string) => void;
}

const RouterContext = createContext<RouterCtx>({
  path: "/",
  navigate: () => {},
});

export function useRouter() {
  return useContext(RouterContext);
}

export function RouterProvider({ children }: { children: ReactNode }) {
  const [path, setPath] = useState(window.location.pathname);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const navigate = useCallback((to: string) => {
    window.history.pushState(null, "", to);
    setPath(to);
    window.scrollTo(0, 0);
  }, []);

  return (
    <RouterContext.Provider value={{ path, navigate }}>
      {children}
    </RouterContext.Provider>
  );
}

export function Link({
  to,
  children,
  className,
  ...rest
}: {
  to: string;
  children: ReactNode;
  className?: string;
} & AnchorHTMLAttributes<HTMLAnchorElement>) {
  const { navigate, path } = useRouter();
  const active = path === to || (to !== "/" && path.startsWith(to));

  return (
    <a
      href={to}
      className={`${className ?? ""}${active ? " nav-active" : ""}`}
      onClick={(e) => {
        if (
          to.startsWith("http") ||
          e.metaKey ||
          e.ctrlKey ||
          e.shiftKey ||
          e.button !== 0
        )
          return;
        e.preventDefault();
        navigate(to);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}
