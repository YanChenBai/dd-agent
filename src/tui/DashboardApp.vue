<script setup lang="ts">
import { Box, Text, useInput } from '@vue-tui/runtime';

import DashboardPanel from './DashboardPanel.vue';
import { formatBytes, formatTime, formatTimeRange } from './format.ts';
import type { DanmakuDelivery, DashboardModule, DashboardState } from './types.ts';

const props = defineProps<{
  state: DashboardState;
  onToggleSendDanmaku: () => void;
}>();

useInput((input, key) => {
  const isKeyPress = key.eventType === undefined || key.eventType === 'press';
  if (isKeyPress && input.toLowerCase() === 's' && !key.ctrl && !key.meta) {
    props.onToggleSendDanmaku();
  }
});

function formatLiveStatus(status: number) {
  switch (status) {
    case 1:
      return '直播中';
    case 2:
      return '轮播中';
    default:
      return '未开播';
  }
}

function latestError(module: DashboardModule) {
  return props.state.errors.findLast(error => error.module === module)?.message;
}

const deliveryLabels: Record<DanmakuDelivery, string> = {
  preview: '预览',
  pending: '发送中',
  sent: '已发送',
  failed: '发送失败',
};

const deliveryColors: Record<DanmakuDelivery, string> = {
  preview: 'yellow',
  pending: 'cyan',
  sent: 'green',
  failed: 'red',
};
</script>

<template>
  <Box flex-direction="column" width="100%" height="100%" :padding="1" overflow="hidden">
    <Box :margin-bottom="1">
      <Text bold color="cyan">DD AGENT</Text>
      <Text dim-color> · 实时感知与弹幕控制台</Text>
    </Box>

    <Box :flex-grow="1" flex-direction="column" border-style="single" overflow="hidden">
      <Box
        :flex-grow="1"
        border-style="single"
        :border-top="false"
        :border-left="false"
        :border-right="false"
        overflow="hidden"
      >
        <DashboardPanel
          title="弹幕输出"
          accent="magenta"
          :status="state.sendDanmakuEnabled ? '发送开启' : '仅预览'"
          :status-color="state.sendDanmakuEnabled ? 'green' : 'yellow'"
          border-right
          :error="latestError('brain')"
        >
          <Text v-if="state.brain.length === 0" dim-color>等待生成弹幕…</Text>
          <Text v-for="entry in state.brain" :key="entry.id" wrap="truncate-end">
            <Text dim-color>{{ formatTimeRange(entry.startTimeMs, entry.endTimeMs) }} </Text>
            <Text :color="deliveryColors[entry.delivery]"
              >[{{ deliveryLabels[entry.delivery] }}]</Text
            >
            {{ entry.message }}
          </Text>
        </DashboardPanel>

        <DashboardPanel title="转写输出" accent="green" :error="latestError('hearing')">
          <Text v-if="state.hearing.length === 0" dim-color>等待语音转写…</Text>
          <Text v-for="entry in state.hearing" :key="entry.id" wrap="truncate-end">
            <Text dim-color
              >#{{ entry.index }} {{ formatTimeRange(entry.startTimeMs, entry.endTimeMs) }}
            </Text>
            {{ entry.text }}
          </Text>
        </DashboardPanel>
      </Box>

      <Box :flex-grow="1" overflow="hidden">
        <DashboardPanel
          title="图像输出"
          accent="yellow"
          border-right
          :error="latestError('vision')"
        >
          <Text v-if="state.vision.length === 0" dim-color>等待视觉帧…</Text>
          <Text v-for="entry in state.vision" :key="entry.id" wrap="truncate-end">
            <Text dim-color>{{ formatTimeRange(entry.startTimeMs, entry.endTimeMs) }} </Text>
            {{ formatBytes(entry.bufferSize) }} · {{ entry.frameCount }} 帧
          </Text>
        </DashboardPanel>

        <DashboardPanel title="直播间" accent="cyan" :error="latestError('room')">
          <Text wrap="truncate-end"
            >主播：{{ state.roomInfo.user.uname }} · UID {{ state.roomInfo.user.uid }}</Text
          >
          <Text wrap="truncate-end"
            >房间：{{ state.roomInfo.room.title }} · #{{ state.roomInfo.room.room_id }}</Text
          >
          <Text wrap="truncate-end"
            >分区：{{ state.roomInfo.room.parent_area_name }} /
            {{ state.roomInfo.room.area_name }}</Text
          >
          <Text
            >状态：<Text :color="state.roomInfo.room.live_status === 1 ? 'green' : 'yellow'">{{
              formatLiveStatus(state.roomInfo.room.live_status)
            }}</Text></Text
          >
          <Text dim-color>启动于 {{ formatTime(state.startedAtMs) }}</Text>
        </DashboardPanel>
      </Box>
    </Box>

    <Box :margin-top="1">
      <Text dim-color>Ctrl+C 退出 · S 切换真实发送</Text>
    </Box>
  </Box>
</template>
