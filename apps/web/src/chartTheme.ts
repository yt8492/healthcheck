export function chartColors(element: HTMLElement) {
  const style = getComputedStyle(element);
  const color = (name: string) => style.getPropertyValue(name).trim();
  return {
    text: color('--text'),
    muted: color('--muted'),
    border: color('--border'),
    surface: color('--surface-raised'),
    primary: color('--chart-primary'),
    range: color('--chart-range'),
  };
}
