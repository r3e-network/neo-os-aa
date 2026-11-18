<template>
  <div class="space-y-4" role="status" aria-busy="true" aria-label="Loading listings">
    <div
      v-for="i in 2"
      :key="'listing-skel-' + i"
      class="gradient-border-card bg-sa-panel/60 backdrop-blur-xl overflow-hidden"
    >
      <div class="p-6 space-y-4">
        <div class="flex items-center justify-between">
          <div class="skeleton h-5 w-40"></div>
          <div class="skeleton h-5 w-20 rounded-full"></div>
        </div>
        <div
          class="rounded-xl border border-sa-border bg-sa-dark/50 p-4 space-y-3"
        >
          <div class="skeleton h-3 w-20"></div>
          <div class="skeleton h-4 w-full"></div>
          <div class="flex gap-4">
            <div class="skeleton h-3 w-32"></div>
            <div class="skeleton h-3 w-32"></div>
          </div>
        </div>
        <div class="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          <div
            v-for="j in 4"
            :key="'skel-detail-' + j"
            class="space-y-1.5"
          >
            <div class="skeleton h-3 w-16"></div>
            <div class="skeleton h-4 w-24"></div>
          </div>
        </div>
      </div>
      <div class="border-t border-sa-border bg-sa-panel/40 p-4">
        <div class="flex items-center justify-between">
          <div class="skeleton h-10 w-64 rounded-xl"></div>
          <div class="skeleton h-9 w-28 rounded-lg"></div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup></script>
