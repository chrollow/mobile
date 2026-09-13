const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const MedicineSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  name: { type: String, required: true },
  batch: { type: String },
  expiryDate: { type: Date, required: false },
  quantity: { type: Number, default: 1 },
  notes: { type: String },
  acknowledgedAt: { type: Date, default: null },
}, { timestamps: true });

MedicineSchema.index({ user: 1, expiryDate: 1 });

module.exports = mongoose.model('Medicine', MedicineSchema);
