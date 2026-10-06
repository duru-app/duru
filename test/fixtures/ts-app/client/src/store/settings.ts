export type Settings = { SYSTEM: { LAB_ENABLED: boolean; REPORT_ENABLED: boolean } };

export const defaults = {
  SYSTEM: {
    LAB_ENABLED: false as boolean,
    REPORT_ENABLED: true,
  },
} satisfies Settings;
