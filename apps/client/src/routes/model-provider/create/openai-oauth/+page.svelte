<script lang="ts">
    import DefaultLayout from "$lib/components/layout/DefaultLayout.svelte";
    import ModelForm from "$lib/components/organism/ModelForm.svelte";
</script>

<DefaultLayout narrow title="Create OpenAI OAuth Model Provider">
    <ModelForm mode="create" authMethod="openaiOauth" />
</DefaultLayout>
