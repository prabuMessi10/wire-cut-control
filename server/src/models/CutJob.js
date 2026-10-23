import mongoose from 'mongoose';

const cutJobSchema = new mongoose.Schema(
  {
    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    lengthMm: { type: Number, required: true, min: 1, max: 100000 },
    qty: { type: Number, required: true, min: 1, max: 200 },
    gauge: { type: String, required: true, trim: true },
    ref: { type: String, default: '', trim: true, maxlength: 200 },
    // "done" | "error" — reflects the outcome of the ESP32 cycle
    status: { type: String, enum: ['done', 'error'], required: true },
    // Raw JSON echoed from the ESP32 / cut-start response, polled /status
    // payloads, or the error object when the cycle failed.
    esp32Response: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true } // createdAt / updatedAt
);

cutJobSchema.index({ createdAt: -1 });

export default mongoose.model('CutJob', cutJobSchema);