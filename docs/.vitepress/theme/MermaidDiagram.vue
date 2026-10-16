<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import { useData } from 'vitepress';

const props = defineProps<{ source: string }>();
const { isDark } = useData();
const svg = ref('');
const failed = ref(false);
const id = `diagram-${useId().replace(/[^a-zA-Z0-9-]/g, '-')}`;
let revision = 0;

onMounted(() => {
  watch([() => props.source, isDark], async () => {
    const current = ++revision;
    failed.value = false;
    try {
      const { default: mermaid } = await import('mermaid');
      if (current !== revision) return;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        htmlLabels: false,
        theme: isDark.value ? 'dark' : 'default',
        suppressErrorRendering: true,
        flowchart: { useMaxWidth: false },
      });
      const result = await mermaid.render(`${id}-${current}`, decodeURIComponent(props.source));
      // Discard stale results after navigation, theme changes, or unmounting.
      if (current === revision) svg.value = result.svg;
    } catch {
      if (current === revision) {
        svg.value = '';
        failed.value = true;
      }
    }
  }, { immediate: true });
});

onBeforeUnmount(() => { revision++; });
</script>

<template>
  <figure class="mermaid-diagram">
    <p v-if="failed" role="alert">Unable to render diagram. View its source below.</p>
    <div v-else-if="svg" class="diagram-image" role="img" tabindex="0" aria-label="System dependency diagram; scroll horizontally to explore" v-html="svg" />
    <p v-else role="status">Loading diagram…</p>
    <details>
      <summary>Diagram source</summary>
      <pre><code>{{ decodeURIComponent(source) }}</code></pre>
    </details>
  </figure>
</template>

<style scoped>
.mermaid-diagram {
  margin: 1.5rem 0;
}
.diagram-image {
  overflow-x: auto;
  text-align: center;
}
.diagram-image :deep(svg) {
  height: auto;
  max-width: none;
}
pre {
  overflow-x: auto;
  padding: 1rem;
  background: var(--vp-code-block-bg);
}
summary {
  cursor: pointer;
}
</style>
