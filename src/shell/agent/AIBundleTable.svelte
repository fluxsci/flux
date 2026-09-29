<script lang="ts">
  import { AI_BUNDLE_TABLE } from './aiBundleTable';
  const rows = AI_BUNDLE_TABLE.split('\n').filter((_, i) => i !== 1).map(line => line.slice(1, -1).split('|').map(s => s.trim().replace(/[`*]/g, '')));
</script>
<details class="bundle-definition"><summary tabindex="0">What is the AI bundle?</summary><div class="table-scroll"><table>
  <thead><tr>{#each rows[0] as cell}<th>{cell}</th>{/each}</tr></thead>
  <tbody>{#each rows.slice(1) as row}<tr>{#each row as cell}<td>{cell}</td>{/each}</tr>{/each}</tbody>
</table></div></details>
<style>
  summary { padding: 12px 0; cursor: var(--cursor-cross-hover); }
  .table-scroll { overflow: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 11px; }
  th, td { text-align: left; vertical-align: top; border: 1px solid var(--c-line); padding: 8px; min-width: 115px; }
</style>
