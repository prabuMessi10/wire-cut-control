import mongoose from 'mongoose';

/** Tiny key/value store for runtime-configurable app settings. */
const appSettingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    value: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

export default mongoose.model('AppSetting', appSettingSchema);