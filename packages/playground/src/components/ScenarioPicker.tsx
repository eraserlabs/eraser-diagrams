import type { Scenario } from '../types.js';

export function ScenarioPicker({
  scenarios,
  value,
  onChange,
}: {
  scenarios: Scenario[];
  value: number;
  onChange: (index: number) => void;
}) {
  const groups = new Map<string, { scenario: Scenario; index: number }[]>();

  scenarios.forEach((scenario, index) => {
    const group = scenario.group ?? 'Scenarios';
    (groups.get(group) ?? groups.set(group, []).get(group)!).push({ scenario, index });
  });

  return (
    <label>
      Scenario{' '}
      <select value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {[...groups.entries()].map(([group, entries]) => (
          <optgroup key={group} label={group}>
            {entries.map(({ scenario, index }) => (
              <option key={scenario.id} value={index}>
                {scenario.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}
