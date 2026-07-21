import mongoose from 'mongoose';
import { initAuthCreds, proto, BufferJSON } from 'baileys';

// Note: data is now stored as a String to prevent MongoDB from altering the Buffers
const authSchema = new mongoose.Schema({
  _id: String,
  data: String
});

const AuthModel = mongoose.model('AuthSession', authSchema);

export async function useMongoAuthState(mongoUrl) {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(mongoUrl);
  }

  const readData = async (id) => {
    try {
      const doc = await AuthModel.findById(id);
      if (doc && doc.data) {
        // Parse the string back into native Node.js Buffers
        return JSON.parse(doc.data, BufferJSON.reviver);
      }
      return null;
    } catch {
      return null;
    }
  };

  const writeData = async (id, data) => {
    // Stringify the objects using Baileys' replacer to safely encode Buffers
    const str = JSON.stringify(data, BufferJSON.replacer);
    await AuthModel.findByIdAndUpdate(id, { data: str }, { upsert: true });
  };

  const removeData = async (id) => {
    await AuthModel.findByIdAndDelete(id);
  };

  const creds = (await readData('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const promises = ids.map(async (id) => {
            let value = await readData(`${type}-${id}`);
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            return [id, value];
          });
          const results = await Promise.all(promises);
          const data = {};
          for (const [id, value] of results) {
            data[id] = value;
          }
          return data;
        },
        set: async (data) => {
          const promises = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              if (value) {
                promises.push(writeData(key, value));
              } else {
                promises.push(removeData(key));
              }
            }
          }
          await Promise.all(promises);
        }
      }
    },
    saveCreds: async () => {
      await writeData('creds', creds);
    }
  };
}