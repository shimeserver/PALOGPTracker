import { Modal, View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';

interface HelpItem { q: string; a: string; }

interface Props {
  visible: boolean;
  onClose: () => void;
  title: string;
  items: HelpItem[];
}

export default function HelpModal({ visible, onClose, title, items }: Props) {
  return (
    <Modal visible={visible} transparent animationType="slide">
      <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={onClose}>
        <TouchableOpacity activeOpacity={1} style={styles.sheet}>
          <View style={styles.handle} />
          <Text style={styles.title}>{title}</Text>
          <ScrollView showsVerticalScrollIndicator={false}>
            {items.map((item, i) => (
              <View key={i} style={styles.item}>
                <Text style={styles.q}>{item.q}</Text>
                <Text style={styles.a}>{item.a}</Text>
              </View>
            ))}
          </ScrollView>
          <TouchableOpacity style={styles.closeBtn} onPress={onClose}>
            <Text style={styles.closeBtnText}>閉じる</Text>
          </TouchableOpacity>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, maxHeight: '80%' },
  handle: { width: 40, height: 4, backgroundColor: '#e5e7eb', borderRadius: 2, alignSelf: 'center', marginBottom: 16 },
  title: { fontSize: 17, fontWeight: '700', color: '#1f2937', marginBottom: 16 },
  item: { marginBottom: 16, paddingBottom: 16, borderBottomWidth: 1, borderBottomColor: '#f3f4f6' },
  q: { fontSize: 14, fontWeight: '600', color: '#2563eb', marginBottom: 4 },
  a: { fontSize: 13, color: '#4b5563', lineHeight: 20 },
  closeBtn: { backgroundColor: '#f3f4f6', borderRadius: 10, padding: 14, alignItems: 'center', marginTop: 8 },
  closeBtnText: { color: '#374151', fontWeight: '600', fontSize: 15 },
});
