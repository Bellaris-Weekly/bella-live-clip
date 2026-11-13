const EDGES = ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'];

export function WindowResizeHandles() {
  return EDGES.map(edge => <span key={edge} class="resize" data-edge={edge} aria-hidden="true" />);
}
