<script setup lang="ts">
defineProps<{ name: string }>()
const paths: Record<string, string> = {
  home: 'M4 5.5h16M4 10h16M4 14.5h10M4 19h7',
  calendar: 'M4.5 6.5h15v13h-15zM4.5 10.5h15M8.5 4v4M15.5 4v4',
  search: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM15.5 15.5 20 20',
  ai: 'M12 3.5l1.8 5.2 5.2 1.8-5.2 1.8L12 17.5l-1.8-5.2L5 10.5l5.2-1.8zM18 16l.8 2.2L21 19l-2.2.8L18 22l-.8-2.2L15 19l2.2-.8z',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3.9a7 7 0 0 0-2.1-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2.1 1.2l-2.3-.9-2 3.4 2 1.5A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.4 2.3-.9a7 7 0 0 0 2.1 1.2L10 21h4l.5-2.6a7 7 0 0 0 2.1-1.2l2.3.9 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z',
  back: 'M15 5l-7 7 7 7',
  left: 'M14.5 6l-6 6 6 6',
  right: 'M9.5 6l6 6-6 6',
  close: 'M6 6l12 12M18 6L6 18',
  pen: 'M4 20l4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10zM13.5 7.5l3 3',
  read: 'M4 5.5c3-1 5.5-.5 8 1.5 2.5-2 5-2.5 8-1.5V19c-3-1-5.5-.5-8 1.5-2.5-2-5-2.5-8-1.5zM12 7v13.5',
  filter: 'M4 6h16M7 12h10M10 18h4',
  trash: 'M5 7h14M10 7V4.5h4V7M7 7l1 13h8l1-13',
  plus: 'M12 5v14M5 12h14',
}
</script>

<template>
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"
    stroke-linejoin="round" aria-hidden="true">
    <path :d="paths[name]" />
  </svg>
</template>
