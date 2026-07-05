<script setup lang="ts">
import { Box, Text } from '@vue-tui/runtime';

defineProps<{
  title: string;
  accent: string;
  error?: string;
  borderRight?: boolean;
}>();
</script>

<template>
  <Box
    flex-direction="column"
    width="50%"
    border-style="single"
    :flex-grow="1"
    :border-top="false"
    :border-left="false"
    :border-right="borderRight"
    :border-bottom="false"
    :padding-x="1"
    overflow="hidden"
  >
    <Text :color="accent" bold>{{ title }}</Text>
    <Text v-if="error" color="red" wrap="truncate-end">错误：{{ error }}</Text>
    <slot />
  </Box>
</template>
