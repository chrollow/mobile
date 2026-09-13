const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const ReminderSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  medicine: { type: Schema.Types.ObjectId, ref: 'Medicine', required: true },
  time: { type: String, required: true },
  repeat: { type: String, enum: ['none', 'daily', 'weekly', 'monthly'], default: 'none' },
  enabled: { type: Boolean, default: true }
}, { timestamps: true });

module.exports = mongoose.model('Reminder', ReminderSchema);
