import mongoose from 'mongoose';

const authSchema = new mongoose.Schema({
  _id: String,
  data: Object
});

const AuthModel = mongoose.model('AuthSession', authSchema);

export async function useMongoAuthState(mongoUrl) {
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(mongoUrl);
  }

  const readData = async (id) => {
    try {
      const doc = await AuthModel.findById(id);
      return doc ? doc.data : null;
    } catch {
      return null;
    }
  };

  const writeData = async (id, data) => {
    await AuthModel.findByIdAndUpdate(id, { data }, { upsert: true });
  };

  const removeData = async (id) => {
    await AuthModel.findByIdAndDelete(id);
  };

  const { initAuthCreds, proto } = await import('baileys');
  const creds = (await readData('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          for (const id of ids) {
            let value = await readData(`${type}-${id}`);
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          }
          return data;
        },
        set: async (data) => {
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              if (value) {
                await writeData(key, value);
              } else {
                await removeData(key);
              }
            }
          }
        }
      }
    },
    saveCreds: async () => {}
  };
}
