import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

interface DetachedCanvasWindowProps {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}

export function DetachedCanvasWindow({ title, children, onClose }: DetachedCanvasWindowProps) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    const popup = window.open(
      '',
      'anvil-canvas',
      'popup=yes,width=1180,height=820,minWidth=640,minHeight=480',
    );
    if (!popup) {
      onClose();
      return;
    }

    popup.document.title = title;
    for (const attribute of document.documentElement.attributes) {
      popup.document.documentElement.setAttribute(attribute.name, attribute.value);
    }
    popup.document.body.className = `${document.body.className} overflow-hidden bg-bg-primary`;

    const base = popup.document.createElement('base');
    base.href = document.baseURI;
    popup.document.head.appendChild(base);

    for (const node of document.head.querySelectorAll('style, link[rel="stylesheet"]')) {
      popup.document.head.appendChild(node.cloneNode(true));
    }

    const mount = popup.document.createElement('div');
    mount.className = 'h-screen w-screen overflow-hidden bg-bg-primary text-text-primary';
    popup.document.body.appendChild(mount);
    setContainer(mount);

    const handleClose = () => onClose();
    popup.addEventListener('beforeunload', handleClose);
    popup.focus();

    return () => {
      popup.removeEventListener('beforeunload', handleClose);
      if (!popup.closed) popup.close();
      setContainer(null);
    };
  }, [onClose, title]);

  return container ? createPortal(children, container) : null;
}
